import type { Deformation } from '../gltf/deformation';
import type { Geometry } from '../gltf/geometry';
import { Resources, uploadBuffer } from './resources';
import { deformationShader } from './deformation-shader';
import {
  GpuDeformationInputCache,
  uploadDeformationStorage,
  type GpuDeformationInputs,
} from './deformation-inputs';

/** One explicit layout and one pipeline cover skin-only, morph-only, and combined meshes.
 * Empty slots still receive neutral buffers, keeping shader and binding interfaces stable. */
export class DeformationCompute {
  readonly layout: GPUBindGroupLayout;
  private constructor(
    readonly pipeline: GPUComputePipeline,
    layout: GPUBindGroupLayout,
  ) {
    this.layout = layout;
  }
  static async create(device: GPUDevice): Promise<DeformationCompute> {
    const layout = device.createBindGroupLayout({
      label: 'Deformation inputs and output',
      entries: Array.from({ length: 7 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: (binding === 0
            ? 'uniform'
            : binding === 6
              ? 'storage'
              : 'read-only-storage') as GPUBufferBindingType,
          minBindingSize: [16, 48, 48, 32, 64, 4, 48][binding],
        },
      })),
    });
    const pipeline = await device.createComputePipelineAsync({
      label: 'Morph then skin',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: deformationShader }),
        entryPoint: 'main',
      },
    });
    return new DeformationCompute(pipeline, layout);
  }
}

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

  update(): void {
    this.data.updatePalette();
    this.data.palette.forEach((matrix, i) => this.paletteData.set(matrix, i * 16));
    this.weightsData.set(this.data.weights);
    if (this.data.skinned)
      this.device.queue.writeBuffer(this.paletteBuffer, 0, this.paletteData.buffer as ArrayBuffer);
    if (this.data.weights.length)
      this.device.queue.writeBuffer(this.weightsBuffer, 0, this.weightsData.buffer as ArrayBuffer);
  }

  dispatch(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.compute.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
  }
}
