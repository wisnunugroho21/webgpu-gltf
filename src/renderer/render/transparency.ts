import type { SceneSampleCount, OutputPass } from '../presentation/output';
export type TransparencyMode = 'weighted' | 'sorted';

/** Weighted blended OIT: additive color/alpha plus logarithmic background coverage.
 * https://jcgt.org/published/0002/02/09/ . Attachments stay per-sample under MSAA;
 * compositing happens in linear HDR before the final resolve and tone mapping. */
export class TransparencyPass {
  private accumulation?: GPUTexture;
  private opticalDepth?: GPUTexture;
  private group?: GPUBindGroup;
  private width = 0;
  private height = 0;
  private constructor(
    private device: GPUDevice,
    private samples: SceneSampleCount,
    private layout: GPUBindGroupLayout,
    private pipeline: GPURenderPipeline,
  ) {}

  static async create(device: GPUDevice, samples: SceneSampleCount): Promise<TransparencyPass> {
    const layout = device.createBindGroupLayout({
      entries: [0, 1].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' as const, multisampled: samples > 1 },
      })),
    });
    const module = device.createShaderModule({
      label: 'Weighted transparency composite',
      code: /* wgsl */ `
@group(0) @binding(0) var accumulation: ${samples > 1 ? 'texture_multisampled_2d' : 'texture_2d'}<f32>;
@group(0) @binding(1) var opticalDepth: ${samples > 1 ? 'texture_multisampled_2d' : 'texture_2d'}<f32>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[index], 0, 1);
}
@fragment fn fragment(@builtin(position) position: vec4f${samples > 1 ? ', @builtin(sample_index) sample: u32' : ''}) -> @location(0) vec4f {
  let coord = vec2u(position.xy);
  // Extreme stacks may saturate float16 additive storage. Clamp infinities to keep
  // the composite and subsequent tone mapping finite, at the cost of accuracy there.
  let sum = min(textureLoad(accumulation, coord, ${samples > 1 ? 'sample' : '0'}), vec4f(65504));
  let logDepth = max(0.0, textureLoad(opticalDepth, coord, ${samples > 1 ? 'sample' : '0'}).r);
  let coverage = 1.0 - exp(-logDepth);
  // RGB was scaled before accumulation to leave headroom in float16 for HDR layers.
  let color = min(sum.rgb / max(sum.a, 0.000001) * 256.0, vec3f(65504));
  return vec4f(color * coverage, coverage);
}`,
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'Weighted transparency composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: 'fragment',
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      multisample: { count: samples },
    });
    return new TransparencyPass(device, samples, layout, pipeline);
  }
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.accumulation?.destroy();
    this.opticalDepth?.destroy();
    this.width = width;
    this.height = height;
    const texture = (format: GPUTextureFormat, label: string) =>
      this.device.createTexture({
        size: [width, height],
        sampleCount: this.samples,
        format,
        label,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.accumulation = texture('rgba16float', 'Transparency accumulation');
    this.opticalDepth = texture('r16float', 'Transparency optical depth');
    this.group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.accumulation.createView() },
        { binding: 1, resource: this.opticalDepth.createView() },
      ],
    });
  }
  begin(encoder: GPUCommandEncoder, depth: GPUTexture): GPURenderPassEncoder {
    if (!this.accumulation || !this.opticalDepth)
      throw new Error('Transparency must be resized before rendering.');
    return encoder.beginRenderPass({
      label: 'Weighted transparency accumulation',
      colorAttachments: [
        {
          view: this.accumulation.createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.opticalDepth.createView(),
          clearValue: [0, 0, 0, 0],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'load',
        depthStoreOp: 'discard',
      },
    });
  }
  composite(encoder: GPUCommandEncoder, output: OutputPass): void {
    const pass = encoder.beginRenderPass({
      label: 'Composite weighted transparency into HDR',
      colorAttachments: [output.sceneAttachment([0, 0, 0, 0], 'load')],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group!);
    pass.draw(3);
    pass.end();
  }
  destroy(): void {
    this.accumulation?.destroy();
    this.opticalDepth?.destroy();
  }
}
