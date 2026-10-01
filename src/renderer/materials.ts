import type { Asset, Material, TextureInfo } from '../gltf/types';
import { Resources, uploadBuffer } from './resources';
import { createMaterialLayoutEntries, materialTextureSlots } from './material-slots';
import { textureCoordinates } from '../gltf/texture-coordinates';
import { MipmapGenerator, mipLevelCount } from './mipmaps';
import { samplerDescriptor } from './samplers';

export interface GpuMaterial {
  bindGroup: GPUBindGroup;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  doubleSided: boolean;
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

  private async image(index: number, format: GPUTextureFormat): Promise<GPUTexture> {
    // The same source image can serve a color slot and a data slot. Include its format
    // in the cache key so data never accidentally receives an sRGB transfer function.
    const key = `${index}/${format}`;
    let result = this.images.get(key);
    if (!result) {
      result = (async () => {
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
          await this.mipmaps.generate(texture);
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
  ) {
    const reference = info ? this.asset.gltf.textures?.[info.index] : undefined;
    if (info && reference?.source === undefined)
      throw new Error(`${label} texture has no image source.`);
    return {
      texture: reference
        ? await this.image(reference.source!, format)
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
    const pbr = definition.pbrMetallicRoughness ?? {};
    const textureEntries: GPUBindGroupEntry[] = [];
    for (const slot of materialTextureSlots) {
      const { texture, sampler } = await this.textureBinding(
        slot.read(definition),
        slot.label,
        slot.format,
        slot.neutral,
      );
      textureEntries.push(
        { binding: slot.samplerBinding, resource: sampler },
        { binding: slot.textureBinding, resource: texture.createView() },
      );
    }
    const alphaMode = definition.alphaMode ?? 'OPAQUE';
    if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode))
      throw new Error('Invalid material alpha mode.');
    // Four material vec4s followed by five pairs of UV-transform rows = 224 bytes.
    const values = new Float32Array(56);
    materialTextureSlots.forEach((slot, i) =>
      values.set(textureCoordinates(slot.read(definition)), 16 + i * 8),
    );
    values.set(pbr.baseColorFactor ?? [1, 1, 1, 1], 0);
    values.set(definition.emissiveFactor ?? [0, 0, 0], 4);
    values[7] = { OPAQUE: 0, MASK: 1, BLEND: 2 }[alphaMode];
    values.set(
      [
        pbr.metallicFactor ?? 1,
        pbr.roughnessFactor ?? 1,
        definition.alphaCutoff ?? 0.5,
        definition.extensions?.KHR_materials_unlit ? 1 : 0,
      ],
      8,
    );
    values.set(
      [
        definition.normalTexture?.scale ?? 1,
        definition.occlusionTexture?.strength ?? 1,
        definition.normalTexture ? 1 : 0,
        // Authored tangents describe TEXCOORD_0. A different or transformed normal UV
        // basis must be recovered from derivatives of that slot's effective coordinates.
        Number(
          values[40] === 1 &&
            values[41] === 0 &&
            values[43] === 0 &&
            values[44] === 0 &&
            values[45] === 1,
        ),
      ],
      12,
    );
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
    return { bindGroup, alphaMode, doubleSided: definition.doubleSided ?? false };
  }
}
