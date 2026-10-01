export const hdrFormat: GPUTextureFormat = 'rgba16float';
export type SceneSampleCount = 1 | 4;
export type ToneMapping = 'reinhard' | 'none';
export interface OutputSettings {
  exposureEV: number;
  toneMapping: ToneMapping;
}

/** Owns viewport HDR storage and presentation. Scene shaders output linear radiance;
 * transparency blends there before this pass applies exposure, a curve, and display encoding. */
export class OutputPass {
  private texture?: GPUTexture;
  private multisampledTexture?: GPUTexture;
  private multisampledView?: GPUTextureView;
  private hdrView?: GPUTextureView;
  private group?: GPUBindGroup;
  private uniform: GPUBuffer;
  private data = new Float32Array(4);
  private current: OutputSettings = { exposureEV: 0, toneMapping: 'reinhard' };
  private width = 0;
  private height = 0;
  private constructor(
    private device: GPUDevice,
    private layout: GPUBindGroupLayout,
    private pipeline: GPURenderPipeline,
    readonly sampleCount: SceneSampleCount,
  ) {
    this.uniform = device.createBuffer({
      label: 'Exposure and tone curve',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.setSettings(this.current);
  }
  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    sampleCount: SceneSampleCount = 1,
  ): Promise<OutputPass> {
    if (sampleCount !== 1 && sampleCount !== 4)
      throw new Error('Scene sample count must be 1 (off) or 4 (MSAA).');
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 16 },
        },
      ],
    });
    const module = device.createShaderModule({
      label: 'HDR presentation',
      code: /* wgsl */ `
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: vec4f;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
fn linearToSrgb(v: vec3f) -> vec3f {
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - 0.055, v * 12.92, v <= vec3f(0.0031308));
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // Exact pixel loads avoid an extra filtering stage. Exposure is 2^EV, applied in linear
  // space. Reinhard retains highlight differences instead of clipping at scene values of one.
  var color = max(textureLoad(scene, vec2i(position.xy), 0).rgb, vec3f(0.0)) * settings.x;
  if (settings.y == 1.0) { color = color / (vec3f(1.0) + color); }
  // Preferred canvas formats are unorm; presentation alone performs sRGB encoding.
  // For an sRGB attachment the hardware handles encoding, so don't apply it twice.
  ${format.endsWith('-srgb') ? '' : 'color = linearToSrgb(color);'}
  return vec4f(color, 1.0);
}`,
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'HDR tone mapping',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
    });
    // Presentation is single-sampled even when scene rendering uses MSAA.
    return new OutputPass(device, layout, pipeline, sampleCount);
  }
  get settings(): Readonly<OutputSettings> {
    return { ...this.current };
  }
  setSettings(settings: Partial<OutputSettings>): void {
    const next = { ...this.current, ...settings };
    if (!Number.isFinite(next.exposureEV) || next.exposureEV < -16 || next.exposureEV > 16)
      throw new Error('Exposure must be finite and between -16 and 16 EV.');
    if (!['none', 'reinhard'].includes(next.toneMapping))
      throw new Error('Unknown tone mapping mode.');
    this.current = next;
    this.data[0] = 2 ** next.exposureEV;
    this.data[1] = Number(next.toneMapping === 'reinhard');
    this.device.queue.writeBuffer(this.uniform, 0, this.data);
  }
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.texture?.destroy();
    this.multisampledTexture?.destroy();
    this.width = width;
    this.height = height;
    this.texture = this.device.createTexture({
      label: 'Linear HDR scene',
      size: [width, height],
      format: hdrFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.hdrView = this.texture.createView();
    if (this.sampleCount > 1) {
      this.multisampledTexture = this.device.createTexture({
        label: 'Multisampled linear HDR scene',
        size: [width, height],
        format: hdrFormat,
        sampleCount: this.sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.multisampledView = this.multisampledTexture.createView();
    }
    this.group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.hdrView },
        { binding: 1, resource: { buffer: this.uniform } },
      ],
    });
  }
  get view(): GPUTextureView {
    if (!this.hdrView) throw new Error('HDR output must be resized before rendering.');
    return this.hdrView;
  }
  /** Geometry blends per sample in linear HDR. Normally discard MSAA samples after
   * resolve; a transmission continuation stores then loads them so coverage and depth
   * survive the opaque snapshot. Tone mapping still happens only after the final resolve. */
  sceneAttachment(
    clearValue: GPUColor,
    loadOp: GPULoadOp = 'clear',
    preserveSamples = false,
  ): GPURenderPassColorAttachment {
    return {
      view: this.multisampledView ?? this.view,
      resolveTarget: this.sampleCount > 1 ? this.view : undefined,
      clearValue,
      loadOp,
      storeOp: this.sampleCount > 1 && !preserveSamples ? 'discard' : 'store',
    };
  }
  /** A transmission pass samples this copy, never its own live render attachment. */
  copyScene(encoder: GPUCommandEncoder, target: GPUTexture): void {
    if (!this.texture) throw new Error('HDR output must be resized before copying.');
    encoder.copyTextureToTexture({ texture: this.texture }, { texture: target }, [
      this.width,
      this.height,
    ]);
  }
  encode(encoder: GPUCommandEncoder, target: GPUTextureView): void {
    if (!this.group) throw new Error('HDR output must be resized before presentation.');
    const pass = encoder.beginRenderPass({
      label: 'Exposure, tone mapping and presentation',
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
  destroy(): void {
    this.texture?.destroy();
    this.multisampledTexture?.destroy();
    this.uniform.destroy();
  }
}
