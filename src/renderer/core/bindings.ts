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
      ],
    });
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
    this.frame = device.createBindGroup({
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
  }

  uploadCamera(camera: OrbitCamera, aspect: number): void {
    this.frameData.set(camera.matrix(aspect));
    this.frameData.set(camera.eye, 16);
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
  }

  destroy(): void {
    this.frameBuffer.destroy();
  }
}
