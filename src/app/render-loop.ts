import type { Renderer } from '../renderer/renderer';

/** Browser scheduling is a viewer concern. Injection permits lifecycle tests without
 * a browser or GPU; engines can instead call Renderer.render from their own loop. */
export interface FrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
}
const browserScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** Small adapter retaining the viewer's continuous animation and camera rendering.
 * It owns only scheduling: the Viewer remains responsible for renderer disposal. */
export class ViewerRenderLoop {
  private request?: number;
  private running = false;
  private disposed = false;
  private generation = 0;

  constructor(
    private renderer: Pick<Renderer, 'render'>,
    private scheduler: FrameScheduler = browserScheduler,
  ) {}

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.schedule(++this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.request !== undefined) this.scheduler.cancel(this.request);
    this.request = undefined;
  }

  destroy(): void {
    this.stop();
    this.disposed = true;
  }

  private schedule(generation: number): void {
    this.request = this.scheduler.request((timestamp) => {
      // A cancelled callback may already be queued. Never let it render or overwrite
      // a request from a restarted loop. Stop/restart inside render is safe as well.
      if (!this.running || generation !== this.generation) return;
      this.request = undefined;
      try {
        if (!this.renderer.render(timestamp)) this.stop();
        else if (this.running && generation === this.generation) this.schedule(generation);
      } catch (error) {
        this.stop();
        throw error;
      }
    });
  }
}
