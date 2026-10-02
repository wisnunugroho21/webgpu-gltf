import type { OrbitCamera } from '../../../../src/engine/camera/orbit-camera';

/** Viewer-owned DOM input; engine cameras remain usable without a browser. */
export class OrbitInput {
  private cleanup: () => void;
  constructor(canvas: HTMLCanvasElement, camera: OrbitCamera) {
    let last: { x: number; y: number; id: number } | undefined;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      last = { x: event.clientX, y: event.clientY, id: event.pointerId };
    };
    const move = (event: PointerEvent) => {
      if (!last || event.pointerId !== last.id) return;
      camera.yaw -= (event.clientX - last.x) * 0.006;
      camera.pitch = Math.max(
        -1.45,
        Math.min(1.45, camera.pitch + (event.clientY - last.y) * 0.006),
      );
      last.x = event.clientX;
      last.y = event.clientY;
    };
    const up = () => {
      last = undefined;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      camera.distance = Math.max(
        camera.radius * 0.15,
        Math.min(camera.radius * 30, camera.distance * Math.exp(event.deltaY * 0.001)),
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
  destroy(): void {
    this.cleanup();
  }
}
