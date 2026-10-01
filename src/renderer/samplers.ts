import type { Gltf } from '../gltf/types';

/** glTF's six minification modes specify both in-level filtering and mip selection.
 * NEAREST/LINEAR without mip filtering must still sample level zero after mip generation. */
export function samplerDescriptor(
  definition: NonNullable<Gltf['samplers']>[number] = {},
): GPUSamplerDescriptor {
  const min = definition.minFilter ?? 9987;
  const wrap = (value?: number): GPUAddressMode =>
    value === 33071 ? 'clamp-to-edge' : value === 33648 ? 'mirror-repeat' : 'repeat';
  return {
    addressModeU: wrap(definition.wrapS),
    addressModeV: wrap(definition.wrapT),
    magFilter: definition.magFilter === 9728 ? 'nearest' : 'linear',
    minFilter: [9728, 9984, 9986].includes(min) ? 'nearest' : 'linear',
    mipmapFilter: [9984, 9985].includes(min) ? 'nearest' : 'linear',
    lodMaxClamp: min === 9728 || min === 9729 ? 0 : 32,
  };
}
