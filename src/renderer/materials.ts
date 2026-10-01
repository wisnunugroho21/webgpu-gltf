import type { Asset, Material, TextureInfo } from '../gltf/types';
import { Resources, uploadBuffer } from './resources';

export interface GpuMaterial {
  bindGroup: GPUBindGroup;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  doubleSided: boolean;
}

export const materialLayoutEntries: GPUBindGroupLayoutEntry[] = [
  {
    binding: 0,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: 'uniform', minBindingSize: 64 },
  },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 9, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
];

/** Separate image/sampler caches mirror glTF's image + sampler = texture model. */
export class MaterialFactory {
  private images = new Map<string, Promise<GPUTexture>>();
  private samplers = new Map<number, GPUSampler>();
  private materials = new Map<number, Promise<GpuMaterial>>();
  private whiteColor: GPUTexture;
  private whiteData: GPUTexture;
  private flatNormal: GPUTexture;

  constructor(
    private device: GPUDevice,
    private asset: Asset,
    private resources: Resources,
    private layout: GPUBindGroupLayout,
  ) {
    this.whiteColor = this.defaultTexture('rgba8unorm-srgb', [255, 255, 255, 255], 'White color');
    this.whiteData = this.defaultTexture('rgba8unorm', [255, 255, 255, 255], 'White data');
    this.flatNormal = this.defaultTexture('rgba8unorm', [128, 128, 255, 255], 'Flat normal');
  }

  private defaultTexture(format: GPUTextureFormat, rgba: number[], label: string): GPUTexture {
    const texture = this.resources.own(
      this.device.createTexture({
        label,
        size: [1, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
    this.device.queue.writeTexture({ texture }, new Uint8Array(rgba), {}, [1, 1]);
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
      const wrap = (value?: number): GPUAddressMode =>
        value === 33071 ? 'clamp-to-edge' : value === 33648 ? 'mirror-repeat' : 'repeat';
      sampler = this.device.createSampler({
        addressModeU: wrap(definition.wrapS),
        addressModeV: wrap(definition.wrapT),
        magFilter: definition.magFilter === 9728 ? 'nearest' : 'linear',
        minFilter: [9728, 9984, 9986].includes(definition.minFilter ?? 9987) ? 'nearest' : 'linear',
        // This intentionally small implementation uploads level zero only.
        mipmapFilter: [9984, 9985].includes(definition.minFilter ?? 9987) ? 'nearest' : 'linear',
        lodMaxClamp: 0,
      });
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
    fallback: GPUTexture,
  ) {
    if (info && ((info.texCoord ?? 0) !== 0 || info.extensions?.KHR_texture_transform))
      throw new Error(`${label} supports TEXCOORD_0 without KHR_texture_transform only.`);
    const reference = info ? this.asset.gltf.textures?.[info.index] : undefined;
    if (info && reference?.source === undefined)
      throw new Error(`${label} texture has no image source.`);
    return {
      texture: reference ? await this.image(reference.source!, format) : fallback,
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
    const baseColor = await this.textureBinding(
      pbr.baseColorTexture,
      'Base color',
      'rgba8unorm-srgb',
      this.whiteColor,
    );
    // A white fallback preserves factor-only emission. With a map, the sampled color
    // must multiply the factor; adding the factor alone washes out assets like DamagedHelmet.
    const emissive = await this.textureBinding(
      definition.emissiveTexture,
      'Emissive',
      'rgba8unorm-srgb',
      this.whiteColor,
    );
    const metallicRoughness = await this.textureBinding(
      pbr.metallicRoughnessTexture,
      'Metallic/roughness',
      'rgba8unorm',
      this.whiteData,
    );
    const normal = await this.textureBinding(
      definition.normalTexture,
      'Normal',
      'rgba8unorm',
      this.flatNormal,
    );
    const occlusion = await this.textureBinding(
      definition.occlusionTexture,
      'Occlusion',
      'rgba8unorm',
      this.whiteData,
    );
    const alphaMode = definition.alphaMode ?? 'OPAQUE';
    if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode))
      throw new Error('Invalid material alpha mode.');
    const values = new Float32Array(16);
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
        0,
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
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: baseColor.sampler },
        { binding: 2, resource: baseColor.texture.createView() },
        { binding: 3, resource: emissive.sampler },
        { binding: 4, resource: emissive.texture.createView() },
        { binding: 5, resource: metallicRoughness.sampler },
        { binding: 6, resource: metallicRoughness.texture.createView() },
        { binding: 7, resource: normal.sampler },
        { binding: 8, resource: normal.texture.createView() },
        { binding: 9, resource: occlusion.sampler },
        { binding: 10, resource: occlusion.texture.createView() },
      ],
    });
    return { bindGroup, alphaMode, doubleSided: definition.doubleSided ?? false };
  }
}
