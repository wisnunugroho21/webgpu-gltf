/** Required extensions are accepted only when their data has a rendering implementation. */
export const supportedExtensions = [
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_volume',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_emissive_strength',
] as const;
