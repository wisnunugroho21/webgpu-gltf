import type { Material, TextureInfo } from '../../gltf/types';

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
  {
    label: 'Clearcoat',
    shaderName: 'clearcoat',
    samplerBinding: 11,
    textureBinding: 12,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (m) => m.extensions?.KHR_materials_clearcoat?.clearcoatTexture,
  },
  {
    label: 'Clearcoat roughness',
    shaderName: 'clearcoatRoughness',
    samplerBinding: 13,
    textureBinding: 14,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (m) => m.extensions?.KHR_materials_clearcoat?.clearcoatRoughnessTexture,
  },
  {
    label: 'Clearcoat normal',
    shaderName: 'clearcoatNormal',
    samplerBinding: 15,
    textureBinding: 16,
    format: 'rgba8unorm',
    neutral: [128, 128, 255, 255],
    read: (m) => m.extensions?.KHR_materials_clearcoat?.clearcoatNormalTexture,
  },
  {
    label: 'Specular strength',
    shaderName: 'specularStrength',
    samplerBinding: 17,
    textureBinding: 18,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (m) => m.extensions?.KHR_materials_specular?.specularTexture,
  },
  {
    label: 'Specular color',
    shaderName: 'specularColor',
    samplerBinding: 19,
    textureBinding: 20,
    format: 'rgba8unorm-srgb',
    neutral: [255, 255, 255, 255],
    read: (m) => m.extensions?.KHR_materials_specular?.specularColorTexture,
  },
  {
    label: 'Transmission',
    shaderName: 'transmission',
    samplerBinding: 21,
    textureBinding: 22,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (m) => m.extensions?.KHR_materials_transmission?.transmissionTexture,
  },
  {
    label: 'Thickness',
    shaderName: 'thickness',
    samplerBinding: 23,
    textureBinding: 24,
    format: 'rgba8unorm',
    neutral: [255, 255, 255, 255],
    read: (m) => m.extensions?.KHR_materials_volume?.thicknessTexture,
  },
];

/** Version 2 adds three vec4s for toon/outline policy. All material and shadow
 * variants migrate together; the twelve texture/sampler slots stay identical. */
export const materialLayoutVersion = 2;
export const materialFactorFloats = 44;
/** Shared by color and alpha-tested shadow shaders; keep field order in sync with packing. */
export const materialShaderStruct = /* wgsl */ `
struct UVTransform { row0: vec4f, row1: vec4f }
struct Material { baseColor: vec4f, emissive: vec4f, parameters: vec4f, textureParameters: vec4f, coat: vec4f, specular: vec4f, transmission: vec4f, attenuation: vec4f, toon: vec4f, shadowTint: vec4f, outline: vec4f, uv: array<UVTransform, ${materialTextureSlots.length}> }
`;
export const materialUniformByteSize = (materialFactorFloats + materialTextureSlots.length * 8) * 4;

/** Visibility is supplied by the renderer so the schema also works in CPU-only tests. */
export function createMaterialLayoutEntries(
  visibility: GPUShaderStageFlags,
  uniformVisibility: GPUShaderStageFlags = visibility,
): GPUBindGroupLayoutEntry[] {
  return [
    {
      binding: 0,
      visibility: uniformVisibility,
      buffer: { type: 'uniform', minBindingSize: materialUniformByteSize },
    },
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
