import type { Material, TextureInfo } from '../gltf/types';

interface MaterialTextureSlot {
  label: string;
  shaderName: string;
  samplerBinding: number;
  textureBinding: number;
  format: GPUTextureFormat;
  neutral: readonly number[];
  read: (material: Material) => TextureInfo | undefined;
}

/** The material interface is independent of shader variants and texture presence.
 * This single table drives layout entries, bind groups, formats, and WGSL declarations.
 * White is the identity for factor multiplication; a normal fallback points along +Z.
 * Emission uses white too, preserving factor-only emission (the default factor is zero). */
export const materialTextureSlots: readonly MaterialTextureSlot[] = [
  {
    label: 'Base color',
    shaderName: 'color',
    samplerBinding: 1,
    textureBinding: 2,
    format: 'rgba8unorm-srgb',
    neutral: [255, 255, 255, 255],
    read: (material) => material.pbrMetallicRoughness?.baseColorTexture,
  },
  {
    label: 'Emissive',
    shaderName: 'emissive',
    samplerBinding: 3,
    textureBinding: 4,
    format: 'rgba8unorm-srgb',
    neutral: [255, 255, 255, 255],
    read: (material) => material.emissiveTexture,
  },
  {
    label: 'Metallic/roughness',
    shaderName: 'metallicRoughness',
    samplerBinding: 5,
    textureBinding: 6,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (material) => material.pbrMetallicRoughness?.metallicRoughnessTexture,
  },
  {
    label: 'Normal',
    shaderName: 'normal',
    samplerBinding: 7,
    textureBinding: 8,
    format: 'rgba8unorm',
    neutral: [128, 128, 255, 255],
    read: (material) => material.normalTexture,
  },
  {
    label: 'Occlusion',
    shaderName: 'occlusion',
    samplerBinding: 9,
    textureBinding: 10,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (material) => material.occlusionTexture,
  },
];

/** Visibility is supplied by the renderer so the schema also works in CPU-only tests. */
export function createMaterialLayoutEntries(
  visibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility, buffer: { type: 'uniform', minBindingSize: 224 } },
    ...materialTextureSlots.flatMap((slot): GPUBindGroupLayoutEntry[] => [
      { binding: slot.samplerBinding, visibility, sampler: { type: 'filtering' } },
      {
        binding: slot.textureBinding,
        visibility,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
    ]),
  ];
}

export const materialTextureDeclarations = materialTextureSlots
  .map(
    (slot) =>
      `@group(2) @binding(${slot.samplerBinding}) var ${slot.shaderName}Sampler: sampler;\n` +
      `@group(2) @binding(${slot.textureBinding}) var ${slot.shaderName}Texture: texture_2d<f32>;`,
  )
  .join('\n');
