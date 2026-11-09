"""Numeric-only MLP ensemble helpers; never reads or writes image data."""
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import helper, numpy_helper
from torch import nn


SEEDS = (0, 1, 2, 3, 4)
SCALE = 10


def network(device='cuda'):
    return nn.Sequential(nn.Linear(1024, 512), nn.GELU(), nn.Dropout(.2), nn.Linear(512, 1)).to(device)


def probabilities(models, features, device='cuda'):
    tensor = torch.as_tensor(features, device=device, dtype=torch.float32)
    with torch.no_grad():
        per_seed = torch.stack([torch.sigmoid(model(tensor * SCALE)).squeeze(-1) for model in models])
    return per_seed.cpu().numpy()


def average_probabilities(per_seed):
    return np.asarray(per_seed, dtype=np.float32).mean(axis=0, dtype=np.float32)


def full_rule(probability, sexy, hentai):
    return (probability > .5) | (sexy > .85) | (hentai > .5)


def save_heads(path, models):
    np.savez_compressed(path, **{f'{index}.{name}': value.detach().cpu().numpy()
                                for index, model in enumerate(models) for name, value in model.state_dict().items()})


def load_heads(path, device='cuda'):
    with np.load(path) as weights:
        models = []
        for index in range(len(SEEDS)):
            model = network(device)
            model.load_state_dict({name: torch.from_numpy(weights[f'{index}.{name}'].copy()).to(device)
                                   for name in model.state_dict()})
            models.append(model.eval())
    return models


def shipped_head(path, device='cuda'):
    graph = onnx.load(str(path))
    model = network(device)
    model.load_state_dict({tensor.name.removeprefix('head.'): torch.from_numpy(numpy_helper.to_array(tensor).copy()).to(device)
                           for tensor in graph.graph.initializer if tensor.name.startswith('head.')})
    return model.eval()


def export_ensemble(tower_path, heads_path, output_path):
    model = onnx.load(str(tower_path))
    nodes = list(model.graph.node)
    first_head = next(index for index, node in enumerate(nodes) if node.name.startswith('/head/'))
    head_nodes = nodes[first_head:]
    assert head_nodes[-1].op_type == 'Sigmoid' and head_nodes[-1].output == ['probs']
    scaled_embedding = head_nodes[0].input[0]
    assert {value.name for value in model.graph.initializer if value.name.startswith('head.')} == {
        'head.0.weight', 'head.0.bias', 'head.3.weight', 'head.3.bias'}
    tower_initializers = [value for value in model.graph.initializer if not value.name.startswith('head.')]
    assert all(value.data_type == onnx.TensorProto.FLOAT16 for value in tower_initializers)
    del model.graph.node[:]
    model.graph.node.extend(nodes[:first_head])
    del model.graph.initializer[:]
    model.graph.initializer.extend(tower_initializers)
    assert head_nodes[-2].op_type == 'Gemm'
    rename = lambda name: name if name == scaled_embedding else f'ensemble/{name}'
    for template in head_nodes[:-2]:
        node = copy.deepcopy(template)
        node.name = rename(node.name)
        original_inputs, original_outputs = list(node.input), list(node.output)
        del node.input[:]
        del node.output[:]
        node.input.extend(rename(name) for name in original_inputs)
        node.output.extend(rename(name) for name in original_outputs)
        model.graph.node.append(node)
    with np.load(heads_path) as weights:
        packed = {
            '0.weight': np.concatenate([weights[f'{index}.0.weight'] for index in range(len(SEEDS))]),
            '0.bias': np.concatenate([weights[f'{index}.0.bias'] for index in range(len(SEEDS))]),
            '3.weight': np.stack([weights[f'{index}.3.weight'] for index in range(len(SEEDS))]).reshape(1, len(SEEDS), 512),
            '3.bias': np.stack([weights[f'{index}.3.bias'] for index in range(len(SEEDS))]).reshape(1, len(SEEDS))}
    for name, array in packed.items():
        model.graph.initializer.append(numpy_helper.from_array(array.astype(np.float32), name=rename(f'head.{name}')))
    model.graph.initializer.extend([
        numpy_helper.from_array(np.array([0, len(SEEDS), 512], np.int64), name='ensemble_shape'),
        numpy_helper.from_array(np.array([2], np.int64), name='ensemble_hidden_axis')])
    model.graph.node.extend([
        helper.make_node('Reshape', [rename(head_nodes[-2].input[0]), 'ensemble_shape'], ['ensemble_hidden'], name='ensemble_reshape'),
        helper.make_node('Mul', ['ensemble_hidden', rename('head.3.weight')], ['ensemble_weighted'], name='ensemble_projection'),
        helper.make_node('ReduceSum', ['ensemble_weighted', 'ensemble_hidden_axis'], ['ensemble_linear'], keepdims=0, name='ensemble_reduce'),
        helper.make_node('Add', ['ensemble_linear', rename('head.3.bias')], ['ensemble_logits'], name='ensemble_bias'),
        helper.make_node('Sigmoid', ['ensemble_logits'], ['ensemble_probabilities'], name='ensemble_sigmoid'),
        helper.make_node('ReduceMean', ['ensemble_probabilities'], ['probs'], axes=[1], keepdims=1, name='ensemble_mean')])
    del model.graph.value_info[:]
    onnx.checker.check_model(model, full_check=True)
    onnx.save(model, str(output_path))
    head_graph = copy.deepcopy(model)
    del head_graph.graph.node[:first_head]
    del head_graph.graph.initializer[:len(tower_initializers)]
    del head_graph.graph.input[:]
    head_graph.graph.input.append(helper.make_tensor_value_info(scaled_embedding, onnx.TensorProto.FLOAT, ['batch', 1024]))
    onnx.checker.check_model(head_graph, full_check=True)
    head_path = Path(output_path).with_suffix('.heads.onnx')
    onnx.save(head_graph, str(head_path))
    metadata = {'seeds': list(SEEDS), 'aggregation': 'mean_probabilities', 'tower_sha256': sha256(tower_path),
                'sha256': sha256(output_path), 'bytes': Path(output_path).stat().st_size,
                'tower_initializers': len(tower_initializers), 'head_count': len(SEEDS), 'head_dtype': 'float32',
                'packed_heads': True}
    Path(str(output_path) + '.json').write_text(json.dumps(metadata, indent=2), encoding='utf8')
    return metadata


def sha256(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()
