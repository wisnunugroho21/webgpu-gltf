import type { Scene, PoseDraw } from './types';

interface Revisions {
  world: number;
  weights: number;
  joints: number[];
}
/** Visibility depends on geometry and the camera, not lights, exposure, or every
 * animated node. Receivers that don't write opaque depth invalidate only themselves. */
export class OcclusionDependencies {
  private records = new Map<PoseDraw, Revisions>();
  reset(): void {
    this.records.clear();
  }
  update(scene: Scene): { depthChanged: boolean; receivers: number[] } {
    let depthChanged = false;
    const receivers: number[] = [];
    for (const update of scene.updates) {
      const deformation = update.deformation?.data;
      const world = deformation?.skinned ? 0 : scene.pose.nodes[update.node].worldRevision;
      const weights = deformation?.weights.length ? deformation.weightsRevision : 0;
      let record = this.records.get(update);
      let changed = !record || record.world !== world || record.weights !== weights;
      if (!record) {
        record = { world, weights, joints: [] };
        this.records.set(update, record);
      }
      deformation?.activeJoints.forEach((joint, i) => {
        const revision = deformation.jointRevision(joint);
        changed ||= record!.joints[i] !== revision;
        record!.joints[i] = revision;
      });
      record.world = world;
      record.weights = weights;
      if (!changed) continue;
      receivers.push(update.draw.firstInstance);
      // MASK can change depth coverage; BLEND and transmission never supply occluders.
      if (update.draw.material.alphaMode !== 'BLEND' && !update.draw.material.transmission)
        depthChanged = true;
    }
    return { depthChanged, receivers };
  }
}
