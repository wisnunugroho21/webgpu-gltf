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
    buffer: { type: 'uniform', minBindingSize: 48 },
  },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
];

/** Separate image/sampler caches mirror glTF's image + sampler = texture model. */
export class MaterialFactory {
  private images = new Map<number, Promise<GPUTexture>>();
  private samplers = new Map<number, GPUSampler>();
  private materials = new Map<number, Promise<GpuMaterial>>();
  private white: GPUTexture;

  constructor(
    private device: GPUDevice,
    private asset: Asset,
    private resources: Resources,
    private layout: GPUBindGroupLayout,
  ) {
    this.white = resources.own(
      device.createTexture({
        label: 'Default white base color',
        size: [1, 1],
        format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
    );
    device.queue.writeTexture(
      { texture: this.white },
      new Uint8Array([255, 255, 255, 255]),
      {},
      [1, 1],
    );
  }

  get(index = -1): Promise<GpuMaterial> {
    let result = this.materials.get(index);
    if (!result) {
      result = this.create(index);
      this.materials.set(index, result);
    }
    return result;
  }

  private async image(index: number): Promise<GPUTexture> {
    let result = this.images.get(index);
    if (!result) {
      result = (async () => {
        const blob = this.asset.images[index];
        if (!blob) throw new Error('Color texture references a missing image.');
        const bitmap = await createImageBitmap(blob, {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
        try {
          const texture = this.resources.own(
            this.device.createTexture({
              label: `glTF image ${index}`,
              size: [bitmap.width, bitmap.height],
              format: 'rgba8unorm-srgb',
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
      this.images.set(index, result);
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

  /** Both base color and emissive maps contain sRGB colors. Share image uploads, but
   * resolve samplers per texture: one image may be used with different filtering. */
  private async colorBinding(info: TextureInfo | undefined, label: string) {
    if (info && ((info.texCoord ?? 0) !== 0 || info.extensions?.KHR_texture_transform))
      throw new Error(`${label} supports TEXCOORD_0 without KHR_texture_transform only.`);
    const reference = info ? this.asset.gltf.textures?.[info.index] : undefined;
    if (info && reference?.source === undefined)
      throw new Error(`${label} texture has no image source.`);
    return {
      texture: reference ? await this.image(reference.source!) : this.white,
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
    const baseColor = await this.colorBinding(pbr.baseColorTexture, 'Base color');
    // A white fallback preserves factor-only emission. With a map, the sampled color
    // must multiply the factor; adding the factor alone washes out assets like DamagedHelmet.
    const emissive = await this.colorBinding(definition.emissiveTexture, 'Emissive');
    const alphaMode = definition.alphaMode ?? 'OPAQUE';
    if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode))
      throw new Error('Invalid material alpha mode.');
    const values = new Float32Array(12);
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
      ],
    });
    return { bindGroup, alphaMode, doubleSided: definition.doubleSided ?? false };
  }
}
