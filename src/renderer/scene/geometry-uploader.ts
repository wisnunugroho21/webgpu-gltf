import type { Asset, Primitive } from '../../gltf/types';
import type { Geometry } from '../../gltf/geometry';
import type { GpuDeformation } from '../deformation/instance';
import { Resources, uploadBuffer } from '../core/resources';

/** Scene-scoped upload caches preserve interleaved views and shared index buffers.
 * Independent deformation output ranges replace only the deformable vertex binding. */
export class GeometryUploader {
  private views = new Map<number, GPUBuffer>();
  private indexBuffers = new Map<Primitive, GPUBuffer>();
  constructor(
    private device: GPUDevice,
    private asset: Asset,
    private resources: Resources,
  ) {}

  upload(primitive: Primitive, geometry: Geometry, deformation?: GpuDeformation) {
    const vertices = geometry.bindings.map((binding) => {
      if (deformation?.source === binding.source)
        return { buffer: deformation.output, offset: deformation.outputOffset };
      if (typeof binding.source !== 'number') {
        const buffer = uploadBuffer(
          this.device,
          this.resources,
          binding.source,
          GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          'Repacked attributes',
        );
        return { buffer, offset: 0 };
      }
      let buffer = this.views.get(binding.source);
      if (!buffer) {
        const view = this.asset.gltf.bufferViews![binding.source];
        buffer = uploadBuffer(
          this.device,
          this.resources,
          new Uint8Array(this.asset.buffers[view.buffer], view.byteOffset ?? 0, view.byteLength),
          GPUBufferUsage.VERTEX,
          `BufferView ${binding.source}`,
        );
        this.views.set(binding.source, buffer);
      }
      return { buffer, offset: binding.offset };
    });
    let index = this.indexBuffers.get(primitive);
    if (!index && geometry.indices) {
      index = uploadBuffer(
        this.device,
        this.resources,
        geometry.indices,
        GPUBufferUsage.INDEX,
        'Primitive indices',
      );
      this.indexBuffers.set(primitive, index);
    }
    return { vertices, index };
  }
}
