import { mat4, vec3 } from 'gl-matrix';
import { perspectiveView, type CameraView } from './view';

/** An orbit camera owns only view state. It never mutates the loaded scene. */
export class OrbitCamera {
  target = vec3.create();
  radius = 1;
  distance = 4;
  yaw = 0.55;
  pitch = 0.3;
  eye = vec3.create();
  frame(min: vec3, max: vec3): void {
    vec3.add(this.target, min, max);
    vec3.scale(this.target, this.target, 0.5);
    this.radius = Math.max(vec3.distance(min, max) * 0.5, 0.01);
    this.reset();
  }
  reset(): void {
    this.yaw = 0.55;
    this.pitch = 0.3;
    this.distance = this.radius * 3.2;
  }
  matrix(aspect: number): Float32Array {
    const camera = this.view(aspect);
    return new Float32Array(mat4.multiply(mat4.create(), camera.projection, camera.view));
  }
  view(aspect: number): CameraView {
    vec3.set(
      this.eye,
      this.target[0] + Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance,
      this.target[1] + Math.sin(this.pitch) * this.distance,
      this.target[2] + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance,
    );
    return perspectiveView(this.eye, this.target, aspect, this.radius * 0.001, this.radius * 100);
  }
}
