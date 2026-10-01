import type { mat4, vec3 } from 'gl-matrix';
import type { Pose } from '../../scene/pose';
import type { GpuDeformation } from '../deformation/instance';
import type { GpuMaterial } from '../materials/factory';
import type { Resources } from '../core/resources';
import type { Bounds } from './frustum';

export interface Draw {
  pipeline: GPURenderPipeline;
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
/** Last frame's scene submissions, excluding compute and fullscreen presentation. */
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
  pose: Pose;
  updates: PoseDraw[];
  pendingDeformations: GpuDeformation[];
  transformData: Float32Array;
  transformBuffer: GPUBuffer;
  resources: Resources;
  instances: GPUBindGroup;
  opaque: Map<GPURenderPipeline, Map<GpuMaterial, Draw[]>>;
  transparent: Draw[];
  visibleTransparent: Draw[];
  draws: Draw[];
  stats: SceneStats;
  min: vec3;
  max: vec3;
}
export interface PoseDraw {
  draw: Draw;
  node: number;
  deformation?: GpuDeformation;
  normal: mat4;
  localBounds: Bounds;
  front: GPURenderPipeline;
  mirrored: GPURenderPipeline;
  worldRevision: number;
}
