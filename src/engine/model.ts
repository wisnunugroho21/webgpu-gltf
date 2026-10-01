import type { Asset } from '../gltf/types';
import { Pose } from '../scene/pose';
import { AnimationController } from '../animation/controller';
import { identifier } from './scene-document';

/** Loaded bytes/definitions are shared, but mutable model poses and playback are
 * instance-owned. Device-specific GPU resources are acquired separately by the renderer. */
export class ModelLibrary {
  private records = new Map<string, { asset: Asset; uri: string }>();
  register(id: string, asset: Asset, uri: string): void {
    identifier(id);
    identifier(uri);
    if (this.records.has(id)) throw new Error(`Model asset ${id} is already registered.`);
    this.records.set(id, { asset, uri });
  }
  get(id: string): Asset {
    const record = this.records.get(id);
    if (!record) throw new Error(`Model asset ${id} is not loaded.`);
    return record.asset;
  }
  references(): Record<string, string> {
    return Object.fromEntries([...this.records].map(([id, record]) => [id, record.uri]));
  }
}

export class ModelInstance {
  readonly pose: Pose;
  readonly animation = new AnimationController();
  constructor(
    readonly assetId: string,
    readonly asset: Asset,
  ) {
    this.pose = new Pose(asset);
    this.animation.setPose(this.pose);
  }
}
