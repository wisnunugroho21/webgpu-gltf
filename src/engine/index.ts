export { World, type WorldChange, type HierarchyStats } from './world';
export {
  EngineRuntime,
  type RuntimeHooks,
  type RuntimeOptions,
  type RuntimeCheckpoint,
  type SimulationStep,
  type EngineFrame,
} from './runtime/runtime';
export { OrbitCamera } from './camera/orbit-camera';
export { FollowCamera } from './camera/follow-camera';
export { perspectiveView, type CameraView } from './camera/view';
export { Entity } from './entity';
export { ModelInstance, ModelLibrary } from './model';
export { LoadedModel } from './loaded-model';
export { loadWorld } from './load-world';
export {
  parseSceneDocument,
  type SceneDocument,
  type EntityDefinition,
  type TransformData,
  type EntityTransformOwner,
  type JsonValue,
} from './scene-document';
export type { TransformField } from '../scene/transform';

export type { RenderInstanceHandle } from './rendering/instance-slots';

export {
  AssetRegistry,
  AssetLoadError,
  type AssetResolver,
  type AssetRegistryOptions,
  type AssetLoadOptions,
  type AssetLease,
} from './assets/registry';
export {
  ComponentRegistry,
  ComponentValidationError,
  type ComponentSchema,
  type ComponentType,
  type VersionedComponentSchema,
  type UnknownComponentPolicy,
} from './components/registry';
export type { EngineSystem, SystemContext } from './systems/scheduler';
export type { LoadWorldOptions } from './load-world';
export { ActionInput, type ActionState } from './input/actions';
export { writePhysicsPosition } from './physics/entity-pose';
export type { PhysicsAdapter, CharacterBody, CharacterMotion, Point3 } from './physics/contracts';
export {
  migrateScene,
  expandPrefab,
  type AuthoringScene,
  type PrefabDefinition,
  type PrefabInstance,
} from './serialization/prefabs';
export { captureSaveState, loadSaveState, type SaveState } from './serialization/save-state';
export { inspectWorld } from './inspection';
export {
  AudioScene,
  type AudioBackend,
  type PcmAudioBackend,
  type AudioEmitter,
  type AudioListenerPose,
} from './audio/audio-scene';

export { WorldEditor } from './editor/world-editor';
export type { EditorCommand, EditorResult } from './editor/commands';
export type {
  CharacterCheckpoint,
  CheckpointCharacterBody,
  CheckpointPhysicsAdapter,
} from './physics/contracts';
