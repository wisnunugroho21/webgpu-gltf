// Public imports for embedding the renderer. Feature implementation files remain internal.
export { Renderer, type RendererOptions, type FrameStats, type SceneStats } from './renderer';
export type {
  OutputSettings,
  ToneMapping,
  SceneSampleCount,
  EnvironmentImage,
  EnvironmentSettings,
} from './renderer';
export { AnimationController, type AnimationState } from './animation/controller';
export { loadFiles, loadUrl, parseGlb } from './gltf/loader';
export type { Asset, Gltf } from './gltf/types';
