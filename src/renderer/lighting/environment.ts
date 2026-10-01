import { Resources, uploadBuffer } from '../core/resources';
import { environmentFilterShader } from './shader';
import { studioEnvironment, validateEnvironment, type EnvironmentImage } from './source';

export interface EnvironmentSettings {
  intensity: number;
  rotation: number;
}
interface Maps {
  resources: Resources;
  diffuse: GPUTexture;
  specular: GPUTexture;
}
const specularSize = 64;
const mipCount = 7;

/** Renderer-owned IBL resources. Preparation is independent of per-frame deformation. */
export class EnvironmentLighting {
  readonly layout: GPUBindGroupLayout;
  bindGroup!: GPUBindGroup;
  private maps?: Maps;
  private readonly resources = new Resources();
  private readonly uniform: GPUBuffer;
  private readonly lut: GPUTexture;
  private readonly sampler: GPUSampler;
  private readonly filterLayout: GPUBindGroupLayout;
  private pipeline!: GPUComputePipeline;
  private state: EnvironmentSettings = { intensity: 1, rotation: 0 };
  private revision = 0;
  private disposed = false;
  get settings(): Readonly<EnvironmentSettings> {
    return { ...this.state };
  }

  static async create(device: GPUDevice): Promise<EnvironmentLighting> {
    const lighting = new EnvironmentLighting(device);
    try {
      lighting.pipeline = await device.createComputePipelineAsync({
        label: 'Environment convolution',
        layout: device.createPipelineLayout({ bindGroupLayouts: [lighting.filterLayout] }),
        compute: {
          module: device.createShaderModule({ code: environmentFilterShader }),
          entryPoint: 'main',
        },
      });
      await lighting.prepare(studioEnvironment(), true);
      return lighting;
    } catch (error) {
      lighting.destroy();
      throw error;
    }
  }

  private constructor(private device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 16 },
        },
      ],
    });
    this.filterLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d-array',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', minBindingSize: 16 },
        },
      ],
    });
    this.uniform = this.resources.own(
      device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );
    this.lut = this.texture(this.resources, 'Environment BRDF LUT', 64, 1, 1);
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    this.setSettings({});
  }

  private texture(
    resources: Resources,
    label: string,
    size: number,
    layers: number,
    mips: number,
  ): GPUTexture {
    return resources.own(
      this.device.createTexture({
        label,
        size: [size, size, layers],
        mipLevelCount: mips,
        format: 'rgba16float',
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      }),
    );
  }

  setSettings(settings: Partial<EnvironmentSettings>): void {
    const next = { ...this.state, ...settings };
    if (!Number.isFinite(next.intensity) || next.intensity < 0 || !Number.isFinite(next.rotation))
      throw new Error(
        'Environment intensity must be finite and nonnegative; rotation must be finite radians.',
      );
    this.state = next;
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([next.intensity, next.rotation, mipCount - 1, 0]),
    );
  }

  setImage(image: EnvironmentImage): Promise<void> {
    return this.prepare(image, false);
  }

  private async prepare(image: EnvironmentImage, makeLut: boolean): Promise<void> {
    validateEnvironment(image);
    if (this.disposed) throw new Error('Environment lighting was disposed.');
    if (Math.max(image.width, image.height) > this.device.limits.maxTextureDimension2D)
      throw new Error('Environment exceeds the device texture dimension limit.');
    const revision = ++this.revision;
    const temporary = new Resources();
    const resources = new Resources();
    this.device.pushErrorScope('validation');
    let failure: unknown;
    let candidate: Maps | undefined;
    try {
      const source = temporary.own(
        this.device.createTexture({
          label: 'Linear environment panorama',
          size: [image.width, image.height],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        }),
      );
      // Copy honors subarray byte offsets and provides an ArrayBuffer-backed upload.
      this.device.queue.writeTexture(
        { texture: source },
        image.pixels.slice().buffer,
        { bytesPerRow: image.width * 16 },
        [image.width, image.height],
      );
      candidate = {
        resources,
        diffuse: this.texture(resources, 'Diffuse irradiance / pi', 16, 6, 1),
        specular: this.texture(resources, 'GGX environment mip chain', specularSize, 6, mipCount),
      };
      const encoder = this.device.createCommandEncoder({ label: 'Prepare environment lighting' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      const dispatch = (
        texture: GPUTexture,
        size: number,
        layers: number,
        mip: number,
        roughness: number,
        mode: number,
      ) => {
        // Each dispatch owns its parameters: later queue writes must not overwrite earlier jobs.
        const buffer = uploadBuffer(
          this.device,
          temporary,
          new Float32Array([roughness, mode, size, 0]),
          GPUBufferUsage.UNIFORM,
          'Environment filter job',
        );
        pass.setBindGroup(
          0,
          this.device.createBindGroup({
            layout: this.filterLayout,
            entries: [
              { binding: 0, resource: source.createView() },
              {
                binding: 1,
                resource: texture.createView({
                  dimension: '2d-array',
                  baseMipLevel: mip,
                  mipLevelCount: 1,
                  arrayLayerCount: layers,
                }),
              },
              { binding: 2, resource: { buffer } },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), layers);
      };
      dispatch(candidate.diffuse, 16, 6, 0, 1, 1);
      for (let mip = 0; mip < mipCount; mip++)
        dispatch(candidate.specular, specularSize >> mip, 6, mip, mip / (mipCount - 1), 0);
      if (makeLut) dispatch(this.lut, 64, 1, 0, 0, 2);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    } catch (error) {
      failure = error;
    }
    const gpuError = await this.device.popErrorScope();
    temporary.destroy();
    if (failure || gpuError || this.disposed || revision !== this.revision) {
      resources.destroy();
      throw (
        failure ??
        new Error(gpuError?.message ?? 'Environment preparation was superseded or disposed.')
      );
    }
    const bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: candidate!.diffuse.createView({ dimension: 'cube' }) },
        { binding: 2, resource: candidate!.specular.createView({ dimension: 'cube' }) },
        { binding: 3, resource: this.lut.createView() },
        { binding: 4, resource: { buffer: this.uniform } },
      ],
    });
    this.maps?.resources.destroy();
    this.maps = candidate;
    this.bindGroup = bindGroup;
  }

  destroy(): void {
    this.disposed = true;
    this.revision++;
    this.maps?.resources.destroy();
    this.resources.destroy();
  }
}
