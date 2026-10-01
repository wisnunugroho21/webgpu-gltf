import { materialLayoutEntries } from '../materials/factory';
import type { OrbitCamera } from '../camera/orbit-camera';

// Instance = world mat4 + inverse-transpose normal mat4, matching render/shader.ts.
export const instanceFloatCount = 32;
export const normalMatrixOffset = 16;
export const instanceByteSize = instanceFloatCount * Float32Array.BYTES_PER_ELEMENT;
const frameFloatCount = 20; // view-projection mat4 + padded camera position vec4

/** Renderer-wide binding contract. Material presence never changes these layouts. */
export class SceneBindings {
  readonly instances: GPUBindGroupLayout;
  readonly materials: GPUBindGroupLayout;
  readonly pipeline: GPUPipelineLayout;
  readonly frame: GPUBindGroup;
  readonly frameData = new Float32Array(frameFloatCount);
  private frameBuffer: GPUBuffer;
  private frameLayout: GPUBindGroupLayout;
  private transmissionSampler: GPUSampler;
  private neutralScene: GPUTexture;

  constructor(
    private device: GPUDevice,
    environmentLayout: GPUBindGroupLayout,
  ) {
    const frameLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: this.frameData.byteLength },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.frameLayout = frameLayout;
    this.instances = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage', minBindingSize: instanceByteSize },
        },
      ],
    });
    this.materials = device.createBindGroupLayout({ entries: materialLayoutEntries });
    this.pipeline = device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, this.instances, this.materials, environmentLayout],
    });
    this.frameBuffer = device.createBuffer({
      size: this.frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.transmissionSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.neutralScene = device.createTexture({
      label: 'Neutral transmission scene',
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.neutralScene }, new Uint16Array(4), {}, [1, 1]);
    this.frame = this.withTransmission(this.neutralScene.createView());
  }

  /** Same frame layout for opaque and glass passes; only the snapshot resource differs. */
  withTransmission(view: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: view },
        { binding: 2, resource: this.transmissionSampler },
      ],
    });
  }

  uploadCamera(camera: OrbitCamera, aspect: number): void {
    this.frameData.set(camera.matrix(aspect));
    this.frameData.set(camera.eye, 16);
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
  }

  destroy(): void {
    this.frameBuffer.destroy();
    this.neutralScene.destroy();
  }
}
