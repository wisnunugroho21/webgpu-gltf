import { deformationShader } from './shader';

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
