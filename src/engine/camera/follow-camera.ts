import { vec3, type ReadonlyVec3 } from 'gl-matrix';
import { perspectiveView, type CameraView } from './view';

/** CPU follow behavior. Gameplay supplies a world-space target after presentation
 * transforms are prepared; browser input and renderer resources are not involved. */
export class FollowCamera {
  readonly eye = vec3.create();
  readonly target = vec3.create();
  readonly offset = vec3.fromValues(0, 2, 5);
  damping = 12;
  near = 0.01;
  far = 1000;
  private initialized = false;

  update(target: ReadonlyVec3, deltaSeconds: number): void {
    if (
      target.length !== 3 ||
      ![...target, ...this.offset, deltaSeconds, this.damping].every(Number.isFinite) ||
      deltaSeconds < 0 ||
      this.damping < 0
    )
      throw new Error('Invalid follow camera target or time.');
    const desired = vec3.add(vec3.create(), target, this.offset);
    const blend = this.initialized ? 1 - Math.exp(-this.damping * deltaSeconds) : 1;
    vec3.copy(this.target, target);
    vec3.lerp(this.eye, this.eye, desired, blend);
    this.initialized = true;
  }
  view(aspect: number): CameraView {
    return perspectiveView(this.eye, this.target, aspect, this.near, this.far);
  }
}
