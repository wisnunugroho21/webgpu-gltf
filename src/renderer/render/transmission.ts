import { hdrFormat, type OutputPass } from '../presentation/output';
import type { SceneBindings } from '../core/bindings';

/** Renderer-owned opaque HDR snapshot. Allocate only for scenes with transmission.
 * Copying after resolve avoids attachment feedback and preserves HDR/MSAA ordering. */
export class TransmissionBuffer {
  private texture?: GPUTexture;
  private width = 0;
  private height = 0;
  group?: GPUBindGroup;
  constructor(
    private device: GPUDevice,
    private bindings: SceneBindings,
  ) {}

  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.texture?.destroy();
    this.width = width;
    this.height = height;
    this.texture = this.device.createTexture({
      label: 'Opaque HDR transmission snapshot',
      size: [width, height],
      format: hdrFormat,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.group = this.bindings.withTransmission(this.texture.createView());
  }

  capture(encoder: GPUCommandEncoder, output: OutputPass): void {
    if (!this.texture) throw new Error('Transmission snapshot must be resized before rendering.');
    output.copyScene(encoder, this.texture);
  }

  refreshLighting(): void {
    if (this.texture) this.group = this.bindings.withTransmission(this.texture.createView());
  }

  destroy(): void {
    this.texture?.destroy();
  }
}
