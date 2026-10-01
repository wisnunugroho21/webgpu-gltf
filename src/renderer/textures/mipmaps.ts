export type MipmapFilter = 'area' | 'alpha-weighted';

/** Area-weighted box filtering includes every overlapping source texel, including
 * fractional edges in odd-sized mip levels. sRGB loads decode before averaging and
 * sRGB attachments encode afterward; data channels and alpha always remain linear. */
export class MipmapGenerator {
  private layout: GPUBindGroupLayout;
  private pipelines = new Map<string, Promise<GPURenderPipeline>>();
  constructor(private device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    });
  }
  private pipeline(format: GPUTextureFormat, filter: MipmapFilter): Promise<GPURenderPipeline> {
    const key = `${format}/${filter}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = this.device.createShaderModule({
        label: 'Area-weighted linear-light mip downsampling',
        code: /* wgsl */ `
override alphaWeighted: bool = false;
@group(0) @binding(0) var source: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let sourceSize = textureDimensions(source);
  let destinationSize = max(sourceSize / 2u, vec2u(1));
  let footprint = vec2f(sourceSize) / vec2f(destinationSize);
  let lower = vec2f(vec2u(position.xy)) * footprint;
  let upper = min(lower + footprint, vec2f(sourceSize));
  let first = vec2u(floor(lower));
  let end = min(vec2u(ceil(upper)), sourceSize);
  var sum = vec4f(0);
  var area = 0.0;
  // A mip step overlaps at most 3x3 texels (2x2 for even dimensions).
  // Weight the shared edge texels fractionally instead of dropping odd columns.
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let texel = vec2f(f32(x), f32(y));
      let overlap = max(vec2f(0), min(upper, texel + 1.0) - max(lower, texel));
      let weight = overlap.x * overlap.y;
      var value = textureLoad(source, vec2u(x, y), 0);
      if (alphaWeighted) { value = vec4f(value.rgb * value.a, value.a); }
      sum += value * weight;
      area += weight;
    }
  }
  var result = sum / area;
  // Translucent base colors are straight-alpha in the material shader. Filter
  // premultiplied RGB, then restore straight RGB; invisible texels contribute no color.
  if (alphaWeighted && result.a > 0.0) { result = vec4f(result.rgb / result.a, result.a); }
  return result;
}`,
      });
      pipeline = this.device.createRenderPipelineAsync({
        label: `Mipmap generator (${key})`,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          constants: { alphaWeighted: Number(filter === 'alpha-weighted') },
          targets: [{ format }],
        },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  async generate(texture: GPUTexture, filter: MipmapFilter = 'area'): Promise<void> {
    if (filter !== 'area' && filter !== 'alpha-weighted') throw new Error('Unknown mipmap filter.');
    if (texture.mipLevelCount <= 1) return;
    const pipeline = await this.pipeline(texture.format, filter);
    const encoder = this.device.createCommandEncoder({ label: 'Generate texture mip chain' });
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          {
            binding: 0,
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
