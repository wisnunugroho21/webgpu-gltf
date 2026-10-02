import { mat4, type ReadonlyMat4, type ReadonlyVec3 } from 'gl-matrix';

/** Borrowed CPU camera data for one render call. Projection uses WebGPU's [0,1]
 * depth range; aspect describes the physical viewport it was prepared for. */
export interface CameraView {
  readonly view: ReadonlyMat4;
  readonly projection: ReadonlyMat4;
  readonly eye: ReadonlyVec3;
  readonly aspect: number;
}

export function validateCameraView(camera: CameraView, aspect: number): void {
  if (
    camera.view.length !== 16 ||
    camera.projection.length !== 16 ||
    camera.eye.length !== 3 ||
    ![...camera.view, ...camera.projection, ...camera.eye, camera.aspect].every(Number.isFinite) ||
    camera.aspect <= 0 ||
    Math.abs(camera.aspect - aspect) > Math.max(1, aspect) * 1e-5
  )
    throw new Error('Camera view must be finite and match the current viewport aspect.');
}

export function perspectiveView(
  eye: ReadonlyVec3,
  target: ReadonlyVec3,
  aspect: number,
  near = 0.01,
  far = 1000,
  fov = Math.PI / 4,
): CameraView {
  if (
    eye.length !== 3 ||
    target.length !== 3 ||
    !(aspect > 0 && near > 0 && far > near && fov > 0 && fov < Math.PI) ||
    ![aspect, near, far, fov, ...eye, ...target].every(Number.isFinite)
  )
    throw new Error('Invalid perspective camera parameters.');
  return {
    view: mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]),
    projection: mat4.perspectiveZO(mat4.create(), fov, aspect, near, far),
    eye: [...eye] as [number, number, number],
    aspect,
  };
}
