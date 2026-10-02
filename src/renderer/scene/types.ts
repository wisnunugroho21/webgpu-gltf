import type { mat4, vec3 } from 'gl-matrix';
import type { Pose } from '../../scene/pose';
import type { GpuDeformation } from '../deformation/instance';
import type { GpuMaterial } from '../materials/factory';
import type { SharedResources, Resources } from '../core/resources';
import type { Bounds } from './frustum';
import type { SceneLights } from '../../scene/lights';
import type { World } from '../../engine/world';
import type { ModelInstance } from '../../engine/model';
import type { InstanceSlots, RenderInstanceHandle } from '../../engine/rendering/instance-slots';

export interface Draw {
  pipeline: GPURenderPipeline;
  shadowPipeline?: GPURenderPipeline;
  material: GpuMaterial;
  vertices: { buffer: GPUBuffer; offset: number }[];
  index?: GPUBuffer;
  indexFormat: GPUIndexFormat;
  count: number;
  firstInstance: number;
  instanceCount: number;
  center: vec3;
  depth: number;
  bounds: Bounds[];
  visibleRuns: number[];
}
/** Last frame's color-scene submissions, excluding shadows, compute and presentation. */
export interface FrameStats {
  draws: number;
  instances: number;
  culledInstances: number;
}
/** Prepared scene totals; visibility may split or omit these draws in a frame. */
export interface SceneStats {
  pipelines: number;
  draws: number;
  instances: number;
}
export interface Scene {
  lights: SceneLights;
  pose: Pose;
  poseRevision?: number;
  /** Nodes/subtrees explicitly reserved for gameplay movement during preparation. */
  movableNodes?: ReadonlySet<number>;
  updates: PoseDraw[];
  pendingDeformations: GpuDeformation[];
  transformData: Float32Array;
  transformBuffer: GPUBuffer;
  resources: Resources;
  instances: GPUBindGroup;
  opaque: Map<GPURenderPipeline, Map<GpuMaterial, Draw[]>>;
  transparent: Draw[];
  visibleTransparent: Draw[];
  transmission: Draw[];
  visibleTransmission: Draw[];
  draws: Draw[];
  stats: SceneStats;
  world?: {
    source: World;
    models: readonly ModelInstance[];
    structureRevision: number;
    uploadedPoseRevisions?: number[];
    parts: ReadonlyMap<ModelInstance, WorldRenderPart>;
    slots: InstanceSlots;
    binding: WorldInstanceBinding;
    /** Commit-only writes to free/reclaimed ranges of a retained binding. */
    activate?: () => void;
  };
  min: vec3;
  max: vec3;
}
export interface PoseDraw {
  /** Model-owned node indices remain local even when several entities share an asset. */
  pose?: Pose;
  draw: Draw;
  node: number;
  deformation?: GpuDeformation;
  normal: mat4;
  localBounds: Bounds;
  front: GPURenderPipeline;
  mirrored: GPURenderPipeline;
  worldRevision: number;
}
export interface WorldRenderPart {
  readonly handle: RenderInstanceHandle;
  readonly data: SceneData;
  readonly lifetime: SharedResources;
}
export interface WorldInstanceBinding {
  readonly capacity: number;
  readonly buffer: GPUBuffer;
  readonly group: GPUBindGroup;
  readonly lifetime: SharedResources;
}

/** Prepared model draw data before a world assigns global transform addresses.
 * Private deformation buffers already exist; instance storage is bound only once. */
export type SceneData = Omit<Scene, 'resources' | 'transformBuffer' | 'instances'>;
