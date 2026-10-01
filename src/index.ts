// Public imports for embedding the renderer. Feature implementation files remain internal.
export { Renderer, type RendererOptions, type FrameStats, type SceneStats } from './renderer';
export type {
  OutputSettings,
  ToneMapping,
  SceneSampleCount,
  EnvironmentImage,
  EnvironmentSettings,
  ShadowSettings,
  ShadowResolution,
  ShadowUpdate,
  ShadowMemoryStats,
  TransparencyMode,
  OcclusionStats,
  CpuTimings,
} from './renderer';
export {
  AnimationController,
  type AnimationState,
  type AnimationLayer,
  type AnimationTransition,
} from './animation/controller';
export { loadFiles, loadUrl, parseGlb } from './gltf/loader';
export type { LoadOptions } from './gltf/loader';
export type { TextureCompression } from './gltf/compression/textures';
export { loadEnvironmentImage, decodeRadiance } from './renderer';
export type { Asset, Gltf } from './gltf/types';
