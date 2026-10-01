import type { OutputPass } from '../presentation/output';

/** Resize color and depth together; every attachment keeps the output sample count. */
export class Viewport {
  width = 0;
  height = 0;
  depth?: GPUTexture;
  constructor(
    private canvas: HTMLCanvasElement,
    private device: GPUDevice,
    private output: OutputPass,
  ) {}
  resize(): void {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(
      1,
      Math.min(
        this.device.limits.maxTextureDimension2D,
        Math.round(this.canvas.clientWidth * ratio),
      ),
    );
    const height = Math.max(
      1,
      Math.min(
        this.device.limits.maxTextureDimension2D,
        Math.round(this.canvas.clientHeight * ratio),
      ),
    );
    if (width === this.width && height === this.height) return;
    this.canvas.width = this.width = width;
    this.canvas.height = this.height = height;
    this.output.resize(width, height);
    this.depth?.destroy();
    this.depth = this.device.createTexture({
      label: 'Viewport depth',
      size: [width, height],
      format: 'depth24plus',
      // Depth coverage must match the HDR color attachment and scene pipelines.
      sampleCount: this.output.sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  destroy(): void {
    this.depth?.destroy();
  }
}
