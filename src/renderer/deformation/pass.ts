import type { Scene } from '../scene/types';

/** Encode deformation only after pose inputs have been uploaded. End this pass before
 * rendering so compute storage writes are available as vertex reads in the next pass.
 * New deformation kernels belong here; queue uploads belong in uploadPose. */
export function encodeDeformation(encoder: GPUCommandEncoder, scene: Scene): void {
  if (!scene.pendingDeformations.length) return;
  const pass = encoder.beginComputePass({ label: 'Scene deformation' });
  for (const deformation of scene.pendingDeformations) deformation.dispatchBatched(pass);
  pass.end();
}
