"""Numeric-only regression tests; no image fixtures or image I/O."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import helper, numpy_helper

from ensemble import SEEDS, average_probabilities, export_ensemble, full_rule, load_heads, network, probabilities, save_heads


class EnsembleTests(unittest.TestCase):
    def test_probability_average_not_logit_average(self):
        values = np.array([[.99, .4], [.4, .6], [.4, .5], [.4, .5], [.4, .5]], np.float32)
        np.testing.assert_allclose(average_probabilities(values), [.518, .5], atol=1e-7)
        self.assertEqual(average_probabilities(values).dtype, np.float32)

    def test_rule_strict_boundaries(self):
        probability = np.array([.5, .50001, 0, 0, 0])
        sexy = np.array([.85, 0, .85001, 0, 0])
        hentai = np.array([.5, 0, 0, .50001, .5])
        np.testing.assert_array_equal(full_rule(probability, sexy, hentai), [False, True, True, True, False])

    def test_head_round_trip(self):
        torch.manual_seed(17)
        models = [network('cpu').eval() for seed in SEEDS]
        features = np.random.default_rng(17).normal(size=(3, 1024)).astype(np.float32) / 32
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'heads.npz'
            save_heads(path, models)
            restored = load_heads(path, 'cpu')
            np.testing.assert_array_equal(probabilities(models, features, 'cpu'), probabilities(restored, features, 'cpu'))

    def test_export_copies_one_tower_and_five_float32_heads(self):
        models = [network('cpu').eval() for seed in SEEDS]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            heads = directory / 'heads.npz'
            save_heads(heads, models)
            graph = helper.make_graph([
                helper.make_node('Cast', ['pixels'], ['tower_half'], to=onnx.TensorProto.FLOAT16, name='/visual/Cast'),
                helper.make_node('Mul', ['tower_half', 'visual.weight'], ['tower_out'], name='/visual/Mul'),
                helper.make_node('Cast', ['tower_out'], ['scaled_embedding'], to=onnx.TensorProto.FLOAT, name='/Cast'),
                helper.make_node('Gemm', ['scaled_embedding', 'head.0.weight', 'head.0.bias'], ['hidden'], transB=1, name='/head/head.0/Gemm'),
                helper.make_node('Relu', ['hidden'], ['activated'], name='/head/Relu'),
                helper.make_node('Gemm', ['activated', 'head.3.weight', 'head.3.bias'], ['logits'], transB=1, name='/head/head.3/Gemm'),
                helper.make_node('Sigmoid', ['logits'], ['probs'], name='/Sigmoid')], 'toy_numeric',
                [helper.make_tensor_value_info('pixels', onnx.TensorProto.FLOAT, ['batch', 1024])],
                [helper.make_tensor_value_info('probs', onnx.TensorProto.FLOAT, ['batch', 1])],
                [numpy_helper.from_array(np.array(1, np.float16), 'visual.weight'),
                 *[numpy_helper.from_array(value.detach().numpy(), 'head.' + name) for name, value in models[0].state_dict().items()]])
            template = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], ir_version=8)
            tower = directory / 'tower.onnx'
            output = directory / 'ensemble.onnx'
            onnx.save(template, str(tower))
            metadata = export_ensemble(tower, heads, output)
            exported = onnx.load(str(output))
            self.assertEqual(metadata['head_count'], 5)
            self.assertEqual(sum(node.name.startswith('/visual/') for node in exported.graph.node), 2)
            self.assertTrue(metadata['packed_heads'])
            self.assertEqual(sum(tensor.data_type == onnx.TensorProto.FLOAT for tensor in exported.graph.initializer), 4)
            self.assertEqual(sum(node.op_type == 'Gemm' for node in exported.graph.node), 1)
            session = ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
            for batch in (1, 3):
                features = np.random.default_rng(batch).normal(size=(batch, 1024)).astype(np.float32)
                actual = session.run(None, {'pixels': features})[0].ravel()
                with torch.no_grad():
                    rounded = torch.from_numpy(features.astype(np.float16).astype(np.float32))
                    expected = torch.stack([torch.sigmoid(model[3](torch.relu(model[0](rounded)))).ravel() for model in models]).mean(0).numpy()
                np.testing.assert_allclose(actual, expected, atol=1e-6)

    def test_dataset_metrics_and_deduplicated_mask(self):
        spec = importlib.util.spec_from_file_location('retrain_ensemble', Path(__file__).with_name('retrain-ensemble.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.dataset_metrics(np.array([.9, .1, .5, .6]), np.array([1, 1, 0, 0]),
                                        np.array([True, False, True, False]), np.zeros(4), np.zeros(4),
                                        np.array([True, False, True, True]))
        self.assertEqual(result['all'], {'nsfw': 1, 'caught': 1, 'sfw': 2, 'fp': 1})
        self.assertEqual(result['calibration'], {'n_0.4_0.6': 2, 'nsfw': 0, 'sfw': 2})

    @unittest.skipUnless(torch.cuda.is_available(), 'CUDA numeric similarity check')
    def test_nearest_cosine_normalizes_and_drops_only_above_threshold(self):
        spec = importlib.util.spec_from_file_location('retrain_ensemble', Path(__file__).with_name('retrain-ensemble.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        nearest = module.nearest_cosine(np.array([[2, 0], [0, 3], [1, 1]], np.float32), np.array([[4, 0]], np.float32))
        np.testing.assert_allclose(nearest, [1, 0, 1 / np.sqrt(2)], atol=1e-7)
        np.testing.assert_array_equal(nearest <= .995, [False, True, True])


if __name__ == '__main__':
    unittest.main()
