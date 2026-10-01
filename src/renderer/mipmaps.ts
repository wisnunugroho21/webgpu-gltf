/** One render pass per level downsamples into a disjoint mip subresource. Sampling an
 * sRGB view decodes before filtering; rendering to sRGB re-encodes RGB while alpha stays
 * linear. Data textures use unorm for both views and keep their numeric channel values. */
export class MipmapGenerator {
  private layout: GPUBindGroupLayout;
  private sampler: GPUSampler;
  private pipelines = new Map<GPUTextureFormat, Promise<GPURenderPipeline>>();
  constructor(private device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
      ],
    });
    this.sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }
  private pipeline(format: GPUTextureFormat): Promise<GPURenderPipeline> {
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      const module = this.device.createShaderModule({
        label: 'Linear-light mip downsampling',
        code: /* wgsl */ `
@group(0) @binding(0) var filtering: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = max(textureDimensions(source) / 2u, vec2u(1));
  return textureSampleLevel(source, filtering, position.xy / vec2f(size), 0.0);
}`,
      });
      pipeline = this.device.createRenderPipelineAsync({
        label: `Mipmap generator (${format})`,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
      });
      this.pipelines.set(format, pipeline);
    }
    return pipeline;
  }
  async generate(texture: GPUTexture): Promise<void> {
    if (texture.mipLevelCount <= 1) return;
    const pipeline = await this.pipeline(texture.format);
    const encoder = this.device.createCommandEncoder({ label: 'Generate texture mip chain' });
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.sampler },
          {
            binding: 1,
            resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
          },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: `Mip level ${level}`,
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }
}

export function mipLevelCount(width: number, height: number): number {
  return 1 + Math.floor(Math.log2(Math.max(width, height)));
}
