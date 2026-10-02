// Public imports for embedding the renderer. Feature implementation files remain internal.
export {
  Renderer,
  type RendererOptions,
  type AssetOptions,
  type FrameStats,
  type SceneStats,
} from './renderer';
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
  type AnimationEvent,
  type RootMotionSettings,
  type AnimationCheckpoint,
} from './animation/controller';
export { loadFiles, loadUrl, parseGlb } from './gltf/loader';
export type { LoadOptions } from './gltf/loader';
export { AssetValidationError, defaultAssetLimits } from './gltf/limits';
export type { AssetLimits } from './gltf/limits';
export type { TextureCompression } from './gltf/compression/textures';
export { loadEnvironmentImage, decodeRadiance } from './renderer';
export type { Asset, Gltf } from './gltf/types';
export {
  World,
  type WorldChange,
  type HierarchyStats,
  EngineRuntime,
  OrbitCamera,
  FollowCamera,
  perspectiveView,
  type RuntimeHooks,
  type RuntimeOptions,
  type SimulationStep,
  type EngineFrame,
  type CameraView,
  Entity,
  ModelInstance,
  ModelLibrary,
  LoadedModel,
  loadWorld,
  parseSceneDocument,
  type SceneDocument,
  type EntityDefinition,
  type TransformData,
  type TransformField,
  type EntityTransformOwner,
  type JsonValue,
} from './engine';

export type { RenderInstanceHandle } from './engine/rendering/instance-slots';

export {
  AssetRegistry,
  AssetLoadError,
  type AssetResolver,
  type AssetRegistryOptions,
  type AssetLoadOptions,
  type AssetLease,
} from './engine/assets/registry';
export {
  ComponentRegistry,
  ComponentValidationError,
  type ComponentSchema,
  type ComponentType,
  type UnknownComponentPolicy,
} from './engine/components/registry';
export type { EngineSystem, SystemContext } from './engine/systems/scheduler';
export type { LoadWorldOptions } from './engine/load-world';
export {
  migrateScene,
  expandPrefab,
  captureSaveState,
  loadSaveState,
  inspectWorld,
  AudioScene,
  ActionInput,
} from './engine';
export type {
  AuthoringScene,
  PrefabDefinition,
  PrefabInstance,
  SaveState,
  RuntimeCheckpoint,
  AudioBackend,
  AudioEmitter,
  AudioListenerPose,
} from './engine';
export type { MemorySnapshot, GpuTimingSnapshot } from './renderer/core/diagnostics';
