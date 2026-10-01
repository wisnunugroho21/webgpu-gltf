import { deformationShader, batchedDeformationShader } from './shader';

/** Each dispatch path has one explicit layout covering skin-only, morph-only, and combined meshes.
 * Empty slots still receive neutral buffers, keeping shader and binding interfaces stable. */
export class DeformationCompute {
  readonly layout: GPUBindGroupLayout;
  private constructor(
    readonly pipeline: GPUComputePipeline,
    layout: GPUBindGroupLayout,
    readonly batchPipeline: GPUComputePipeline,
    readonly batchLayout: GPUBindGroupLayout,
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
    const batchLayout = device.createBindGroupLayout({
      label: 'Batched deformation inputs and jobs',
      entries: Array.from({ length: 8 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: (binding === 0
            ? 'uniform'
            : binding === 6
              ? 'storage'
              : 'read-only-storage') as GPUBufferBindingType,
          minBindingSize: [32, 48, 48, 32, 64, 4, 48, 4][binding],
        },
      })),
    });
    const [pipeline, batchPipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'Morph then skin',
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
          module: device.createShaderModule({ code: deformationShader }),
          entryPoint: 'main',
        },
      }),
      device.createComputePipelineAsync({
        label: 'Batched morph then skin',
        layout: device.createPipelineLayout({ bindGroupLayouts: [batchLayout] }),
        compute: {
          module: device.createShaderModule({ code: batchedDeformationShader }),
          entryPoint: 'main',
        },
      }),
    ]);
    return new DeformationCompute(pipeline, layout, batchPipeline, batchLayout);
  }
}
