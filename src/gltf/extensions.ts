/** Required extensions are accepted only when their data has a rendering implementation. */
export const supportedExtensions = [
  'EXT_meshopt_compression',
  'KHR_draco_mesh_compression',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_volume',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_emissive_strength',
] as const;
