import type { Deformation } from '../../scene/deformation';
import type { Geometry } from '../../gltf/geometry';
import { Resources, uploadBuffer } from '../core/resources';
import { DeformationCompute } from './compute';
import {
  GpuDeformationInputCache,
  uploadDeformationStorage,
  type GpuDeformationInputs,
} from './inputs';

/** Node-owned GPU output and pose uploads consuming scene-shared immutable inputs. The output is
 * bound as STORAGE in compute and VERTEX in the subsequent render pass, without a CPU copy. */
export class GpuDeformation {
  readonly output: GPUBuffer;
  readonly source: Float32Array;
  readonly inputs: GpuDeformationInputs;
  readonly group: GPUBindGroup;
  readonly count: number;
  private paletteData: Float32Array;
  private weightsData: Float32Array;
  private paletteBuffer: GPUBuffer;
  private weightsBuffer: GPUBuffer;
  private jointRevisions: number[];
  private weightsRevision = -1;
  private pending = true;

  constructor(
    private device: GPUDevice,
    resources: Resources,
    readonly data: Deformation,
    private compute: DeformationCompute,
    cache = new GpuDeformationInputCache(device, resources),
  ) {
    this.inputs = cache.get(data);
    this.count = this.inputs.count;
    this.source = this.inputs.source;
    this.paletteData = new Float32Array(Math.max(16, data.palette.length * 16));
    this.weightsData = new Float32Array(Math.max(1, data.weights.length));
    this.jointRevisions = data.activeJoints.map(() => -1);
    const storage = (array: ArrayBufferView, label: string, dynamic = false) =>
      uploadDeformationStorage(device, resources, array, label, dynamic);
    this.paletteBuffer = storage(this.paletteData, 'Joint palette', true);
    this.weightsBuffer = storage(this.weightsData, 'Morph weights', true);
    const parameters = uploadBuffer(
      device,
      resources,
      new Uint32Array([
        this.count,
        data.weights.length,
        data.influences.length,
        Number(data.skinned),
      ]),
      GPUBufferUsage.UNIFORM,
      'Deformation counts',
    );
    // COPY_SRC permits numeric GPU regression tests; playback never maps or reads output.
    this.output = resources.own(
      device.createBuffer({
        label: 'Deformed vertex output',
        size: this.source.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
      }),
    );
    this.group = device.createBindGroup({
      layout: compute.layout,
      entries: [
        parameters,
        this.inputs.base,
        this.inputs.targets,
        this.inputs.influences,
        this.paletteBuffer,
        this.weightsBuffer,
        this.output,
      ].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    this.update();
  }

  geometry(base: Geometry): Geometry {
    const geometry = this.data.geometry(base);
    const bindings = geometry.bindings.filter(
      (binding) => !this.data.streams.some((stream) => stream.values === binding.source),
    );
    bindings.push({
      source: this.source,
      offset: 0,
      layout: {
        arrayStride: 48,
        stepMode: 'vertex',
        attributes: this.data.streams.map((stream) => ({
          shaderLocation: { POSITION: 0, NORMAL: 1, TANGENT: 4 }[
            stream.semantic as 'POSITION' | 'NORMAL' | 'TANGENT'
          ],
          offset: { POSITION: 0, NORMAL: 16, TANGENT: 32 }[
            stream.semantic as 'POSITION' | 'NORMAL' | 'TANGENT'
          ],
          format: `float32x${stream.width}` as GPUVertexFormat,
        })),
      },
    });
    bindings.sort(
      (a, b) =>
        [...a.layout.attributes][0].shaderLocation - [...b.layout.attributes][0].shaderLocation,
    );
    return { ...geometry, bindings };
  }

  /** Renderer playback uses revisions; explicit update() still uploads all pose inputs
   * for callers/tests that directly modify the CPU reference arrays. */
  updateChanged(): boolean {
    // Mesh-node transforms don't skin vertices; only positively weighted joint slots
    // and this node's morph weights affect its output. First output is still mandatory.
    const paletteChanged =
      this.data.skinned &&
      this.jointRevisions.some(
        (revision, i) => revision !== this.data.jointRevision(this.data.activeJoints[i]),
      );
    const weightsChanged =
      !!this.data.weights.length && this.weightsRevision !== this.data.weightsRevision;
    if (paletteChanged || weightsChanged) this.update(paletteChanged, weightsChanged);
    return this.pending;
  }

  update(paletteChanged = true, weightsChanged = true): void {
    if (paletteChanged && this.data.skinned) {
      this.data.updatePalette();
      this.data.palette.forEach((matrix, i) => this.paletteData.set(matrix, i * 16));
      this.device.queue.writeBuffer(this.paletteBuffer, 0, this.paletteData.buffer as ArrayBuffer);
      this.jointRevisions.forEach((_, i) => {
        this.jointRevisions[i] = this.data.jointRevision(this.data.activeJoints[i]);
      });
    }
    if (weightsChanged && this.data.weights.length) {
      this.weightsData.set(this.data.weights);
      this.device.queue.writeBuffer(this.weightsBuffer, 0, this.weightsData.buffer as ArrayBuffer);
      this.weightsRevision = this.data.weightsRevision;
    }
    this.pending = true;
  }

  dispatch(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.compute.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    this.pending = false;
  }
}
