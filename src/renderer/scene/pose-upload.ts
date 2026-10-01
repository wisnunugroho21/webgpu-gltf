import { mat4, vec3 } from 'gl-matrix';
import type { Scene } from './types';
import { transformBounds } from './frustum';
import { instanceFloatCount, normalMatrixOffset } from '../core/bindings';
import { prepareDeformationBatches } from '../deformation/batch';

/** Playback already evaluated the pose; this phase only updates render-side resources. */
export function uploadPose(device: GPUDevice, scene: Scene): void {
  // Transform records follow draw order. Coalesce only adjacent dirty records, so
  // unchanged nodes are neither rewritten nor included in a whole-scene upload.
  let start = -1,
    end = -1;
  const flushTransforms = () => {
    if (start >= 0)
      device.queue.writeBuffer(
        scene.transformBuffer,
        start * 4,
        scene.transformData.buffer as ArrayBuffer,
        start * 4,
        (end - start) * 4,
      );
  };
  for (const update of scene.updates) {
    const deformationChanged = update.deformation?.updateChanged() ?? false;
    if (deformationChanged) scene.pendingDeformations.push(update.deformation!);
    const pose = update.pose ?? scene.pose;
    const node = pose.nodes[update.node];
    const worldChanged = node.worldRevision !== update.worldRevision;
    update.worldRevision = node.worldRevision;
    const skinned = update.deformation?.data.skinned;
    if (skinned && worldChanged)
      update.draw.pipeline = pose.rootMirrored ? update.mirrored : update.front;
    // Skinned output is already world-space. Moving only the mesh node cannot
    // require a transform upload or recomputation unless it also moves a joint.
    if (!worldChanged && !deformationChanged) continue;
    const world = node.world;
    if (worldChanged && !skinned) {
      if (!mat4.invert(update.normal, world)) mat4.identity(update.normal);
      mat4.transpose(update.normal, update.normal);
      const offset = update.draw.firstInstance * instanceFloatCount;
      scene.transformData.set(world, offset);
      scene.transformData.set(update.normal, offset + normalMatrixOffset);
      update.draw.pipeline = mat4.determinant(world) < 0 ? update.mirrored : update.front;
      if (offset !== end) {
        flushTransforms();
        start = offset;
      }
      end = offset + instanceFloatCount;
    }
    if (skinned && !deformationChanged) continue;
    // Bounds depend on the same pose revisions as the output, so cached visibility
    // bounds cannot become stale when animated geometry crosses the frustum.
    if (deformationChanged)
      update.deformation!.data.bounds(update.localBounds.min, update.localBounds.max);
    const bounds = update.draw.bounds[0];
    if (skinned) {
      vec3.copy(bounds.min, update.localBounds.min);
      vec3.copy(bounds.max, update.localBounds.max);
    } else transformBounds(bounds, update.localBounds, world);
    vec3.scale(update.draw.center, vec3.add(update.draw.center, bounds.min, bounds.max), 0.5);
  }
  flushTransforms();
  prepareDeformationBatches(scene.pendingDeformations);
}
