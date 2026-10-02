import type { Asset } from '../gltf/types';
import { Pose } from '../scene/pose';
import { AnimationController } from '../animation/controller';
import { AssetRegistry } from './assets/registry';
import { LoadedModel } from './loaded-model';
import type { TransformData, TransformField } from '../scene/transform';

/** Loaded bytes/definitions are shared, but mutable model poses and playback are
 * instance-owned. Device-specific GPU resources are acquired separately by the renderer. */
export class ModelLibrary extends AssetRegistry {}

export class ModelInstance {
  readonly resources: LoadedModel;
  readonly pose: Pose;
  readonly animation = new AnimationController();
  constructor(
    readonly assetId: string,
    source: Asset | LoadedModel,
  ) {
    // Direct callers can pass a LoadedModel to share resources without a library.
    // The existing (id, Asset) constructor still creates a standalone resource set.
    this.resources = source instanceof LoadedModel ? source : new LoadedModel(source);
    this.pose = new Pose(this.asset, this.resources.clips);
    this.animation.setPose(this.pose);
  }
  get asset(): Asset {
    return this.resources.asset;
  }
  getNodeTransform(node: number): TransformData {
    return this.pose.getNodeTransform(node);
  }
  setNodeTransform(node: number, patch: Partial<TransformData>): boolean {
    return this.pose.setNodeTransform(node, patch);
  }
  clearNodeTransform(node: number): boolean {
    return this.pose.clearNodeTransform(node);
  }
  /** Animation owns node locals by default; these methods explicitly claim only
   * supplied fields, for IK, aim offsets or other application-controlled poses. */
  getNodeOverride(node: number): Partial<TransformData> {
    return this.pose.getNodeOverride(node);
  }
  setNodeOverride(node: number, patch: Partial<TransformData>): boolean {
    return this.pose.setNodeTransform(node, patch);
  }
  clearNodeOverride(node: number, fields?: readonly TransformField[]): boolean {
    return this.pose.clearNodeTransform(node, fields);
  }
}
