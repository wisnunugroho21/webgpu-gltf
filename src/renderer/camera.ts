import { mat4, vec3 } from 'gl-matrix';

/** An orbit camera owns only view state. It never mutates the loaded scene. */
export class OrbitCamera {
  target = vec3.create();
  radius = 1;
  distance = 4;
  yaw = 0.55;
  pitch = 0.3;
  eye = vec3.create();
  private cleanup: () => void;
  constructor(canvas: HTMLCanvasElement) {
    let last: { x: number; y: number; id: number } | undefined;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      last = { x: event.clientX, y: event.clientY, id: event.pointerId };
    };
    const move = (event: PointerEvent) => {
      if (!last || event.pointerId !== last.id) return;
      this.yaw -= (event.clientX - last.x) * 0.006;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + (event.clientY - last.y) * 0.006));
      last.x = event.clientX;
      last.y = event.clientY;
    };
    const up = () => {
      last = undefined;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      this.distance = Math.max(
        this.radius * 0.15,
        Math.min(this.radius * 30, this.distance * Math.exp(event.deltaY * 0.001)),
      );
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('lostpointercapture', up);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.cleanup = () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
    };
  }
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
    vec3.set(
      this.eye,
      this.target[0] + Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance,
      this.target[1] + Math.sin(this.pitch) * this.distance,
      this.target[2] + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance,
    );
    const view = mat4.lookAt(mat4.create(), this.eye, this.target, [0, 1, 0]);
    // WebGPU uses a [0, 1] depth range, unlike OpenGL's [-1, 1].
    const projection = mat4.perspectiveZO(
      mat4.create(),
      Math.PI / 4,
      aspect,
      this.radius * 0.001,
      this.radius * 100,
    );
    return new Float32Array(mat4.multiply(projection, projection, view));
  }
  destroy(): void {
    this.cleanup();
  }
}
