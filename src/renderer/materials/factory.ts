import type { Asset, Material, TextureInfo } from '../../gltf/types';
import { Resources, uploadBuffer } from '../core/resources';
import { createMaterialLayoutEntries, materialTextureSlots } from './slots';
import { materialUniform } from './uniform';
import { MipmapGenerator, mipLevelCount, type MipmapFilter } from '../textures/mipmaps';
import { samplerDescriptor } from '../textures/samplers';

export interface GpuMaterial {
  bindGroup: GPUBindGroup;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  doubleSided: boolean;
  transmission?: boolean;
}

export const materialLayoutEntries = createMaterialLayoutEntries(GPUShaderStage.FRAGMENT);

/** Separate image/sampler caches mirror glTF's image + sampler = texture model. */
export class MaterialFactory {
  private images = new Map<string, Promise<GPUTexture>>();
  private samplers = new Map<number, GPUSampler>();
  private materials = new Map<number, Promise<GpuMaterial>>();
  private defaults = new Map<string, GPUTexture>();

  constructor(
    private device: GPUDevice,
    private asset: Asset,
    private resources: Resources,
    private layout: GPUBindGroupLayout,
    private mipmaps: MipmapGenerator,
  ) {}

  private defaultTexture(
    format: GPUTextureFormat,
    rgba: readonly number[],
    label: string,
  ): GPUTexture {
    const key = `${format}/${rgba.join(',')}`;
    const cached = this.defaults.get(key);
    if (cached) return cached;
    const texture = this.resources.own(
      this.device.createTexture({
        label,
        size: [1, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
    this.device.queue.writeTexture({ texture }, new Uint8Array(rgba), {}, [1, 1]);
    this.defaults.set(key, texture);
    return texture;
  }

  get(index = -1): Promise<GpuMaterial> {
    let result = this.materials.get(index);
    if (!result) {
      result = this.create(index);
      this.materials.set(index, result);
    }
    return result;
  }

  private async image(
    index: number,
    format: GPUTextureFormat,
    filter: MipmapFilter,
  ): Promise<GPUTexture> {
    // The same source image can serve a color slot and a data slot. Include its format
    // in the cache key so data never accidentally receives an sRGB transfer function.
    // Generated chains depend on filtering semantics. Authored chains are unchanged,
    // so they can still share one allocation across translucent and opaque slots.
    const decoded = this.asset.decodedImages?.get(index);
    const effectiveFilter = decoded && decoded.levels.length > 1 ? 'area' : filter;
    const key = `${index}/${format}/${effectiveFilter}`;
    let result = this.images.get(key);
    if (!result) {
      result = (async () => {
        if (decoded) {
          const base = decoded.levels[0];
          if (!base) throw new Error('Decoded texture has no mip levels.');
          const generate = decoded.levels.length === 1;
          const texture = this.resources.own(
            this.device.createTexture({
              label: `glTF KTX2 image ${index} (${format})`,
              size: [base.width, base.height],
              format,
              mipLevelCount: generate
                ? mipLevelCount(base.width, base.height)
                : decoded.levels.length,
              usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                (generate ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
            }),
          );
          // Preserve authored mipmaps. RGBA bytes are uploaded unchanged and interpreted
          // by this slot's sRGB/linear texture format, just like PNG/JPEG image uploads.
          for (const [mipLevel, level] of decoded.levels.entries()) {
            if (
              level.width !== Math.max(1, base.width >> mipLevel) ||
              level.height !== Math.max(1, base.height >> mipLevel) ||
              level.data.byteLength !== level.width * level.height * 4
            )
              throw new Error('Invalid decoded texture mip dimensions.');
            this.device.queue.writeTexture(
              { texture, mipLevel },
              level.data,
              { bytesPerRow: level.width * 4, rowsPerImage: level.height },
              [level.width, level.height],
            );
          }
          if (generate) await this.mipmaps.generate(texture, filter);
          return texture;
        }
        const blob = this.asset.images[index];
        if (!blob) throw new Error('Texture references a missing image.');
        const bitmap = await createImageBitmap(blob, {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
        try {
          const texture = this.resources.own(
            this.device.createTexture({
              label: `glTF image ${index} (${format})`,
              size: [bitmap.width, bitmap.height],
              format,
              mipLevelCount: mipLevelCount(bitmap.width, bitmap.height),
              usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
            }),
          );
          // glTF UVs and browser image rows both start at the top; no vertical flip is needed.
          this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture, premultipliedAlpha: false },
            [bitmap.width, bitmap.height],
          );
          await this.mipmaps.generate(texture, filter);
          return texture;
        } finally {
          bitmap.close();
        }
      })();
      this.images.set(key, result);
    }
    return result;
  }

  private sampler(index = -1): GPUSampler {
    let sampler = this.samplers.get(index);
    if (!sampler) {
      const definition = this.asset.gltf.samplers?.[index] ?? {};
      sampler = this.device.createSampler(samplerDescriptor(definition));
      this.samplers.set(index, sampler);
    }
    return sampler;
  }

  /** Color slots decode sRGB; normal, occlusion, and metallic/roughness are linear data.
   * Samplers are resolved per texture even when their source image is shared. */
  private async textureBinding(
    info: TextureInfo | undefined,
    label: string,
    format: GPUTextureFormat,
    neutral: readonly number[],
    filter: MipmapFilter,
  ) {
    const reference = info ? this.asset.gltf.textures?.[info.index] : undefined;
    if (info && reference?.source === undefined)
      throw new Error(`${label} texture has no image source.`);
    return {
      texture: reference
        ? await this.image(reference.source!, format, filter)
        : this.defaultTexture(format, neutral, `${label} neutral default`),
      sampler: this.sampler(reference?.sampler),
    };
  }

  private async create(index: number): Promise<GpuMaterial> {
    const definition: Material =
      index === -1
        ? {}
        : (this.asset.gltf.materials?.[index] ??
          (() => {
            throw new Error(`Missing material ${index}.`);
          })());
    // Validate pure factors before decoding images or allocating candidate textures.
    const values = materialUniform(definition);
    const textureEntries: GPUBindGroupEntry[] = [];
    for (const slot of materialTextureSlots) {
      const { texture, sampler } = await this.textureBinding(
        slot.read(definition),
        slot.label,
        slot.format,
        slot.neutral,
        slot.shaderName === 'color' && definition.alphaMode === 'BLEND' ? 'alpha-weighted' : 'area',
      );
      textureEntries.push(
        { binding: slot.samplerBinding, resource: sampler },
        { binding: slot.textureBinding, resource: texture.createView() },
      );
    }
    const alphaMode = definition.alphaMode ?? 'OPAQUE';
    const uniform = uploadBuffer(
      this.device,
      this.resources,
      values,
      GPUBufferUsage.UNIFORM,
      `Material ${index}`,
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: uniform } }, ...textureEntries],
    });
    return {
      bindGroup,
      alphaMode,
      doubleSided:
        values[24] > 0 && values[25] > 0 && values[11] === 0
          ? false
          : (definition.doubleSided ?? false),
      transmission: values[24] > 0 && values[11] === 0,
    };
  }
}
