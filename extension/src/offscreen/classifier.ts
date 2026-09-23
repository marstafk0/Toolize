import type { Scores } from '../shared/policy';

/**
 * Model-agnostic classifier contract. The pipeline hands it square RGBA crops already
 * resized to `inputSize`; the classifier only runs inference. v1 = NSFWJS MobileNetV2
 * on TF.js; v2 can drop in an ONNX ViT (onnxruntime-web, wasm/WebGPU) behind this.
 */
export interface ImageClassifier {
  readonly modelName: string;
  readonly inputSize: number;
  /** Backend actually in use, e.g. 'webgl' / 'cpu'. Valid after load(). */
  readonly backend: string;
  load(): Promise<void>;
  /** One Scores per input, same order. Inputs are inputSize x inputSize. */
  classifyBatch(inputs: ImageData[]): Promise<Scores[]>;
}
