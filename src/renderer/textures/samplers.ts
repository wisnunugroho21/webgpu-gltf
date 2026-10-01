import type { Gltf } from '../../gltf/types';

/** glTF's six minification modes specify both in-level filtering and mip selection.
 * NEAREST/LINEAR without mip filtering must still sample level zero after mip generation. */
export function samplerDescriptor(
  definition: NonNullable<Gltf['samplers']>[number] = {},
  requestedAnisotropy = 16,
): GPUSamplerDescriptor {
  if (!Number.isInteger(requestedAnisotropy) || requestedAnisotropy < 1 || requestedAnisotropy > 16)
    throw new Error('Anisotropy must be an integer between 1 and 16.');
  const min = definition.minFilter ?? 9987;
  const wrap = (value?: number): GPUAddressMode =>
    value === 33071 ? 'clamp-to-edge' : value === 33648 ? 'mirror-repeat' : 'repeat';
  const descriptor: GPUSamplerDescriptor = {
    addressModeU: wrap(definition.wrapS),
    addressModeV: wrap(definition.wrapT),
    magFilter: definition.magFilter === 9728 ? 'nearest' : 'linear',
    minFilter: [9728, 9984, 9986].includes(min) ? 'nearest' : 'linear',
    mipmapFilter: [9984, 9985].includes(min) ? 'nearest' : 'linear',
    lodMaxClamp: min === 9728 || min === 9729 ? 0 : 32,
  };
  // WebGPU requires all three filters to be linear when anisotropy exceeds one.
  // Preserve authored nearest/non-mip modes instead of changing glTF sampler semantics.
  // The platform clamps the requested quality to its supported maximum; no extra feature
  // flag is required. Passing one disables this enhancement for compatible samplers too.
  descriptor.maxAnisotropy =
    descriptor.magFilter === 'linear' &&
    descriptor.minFilter === 'linear' &&
    descriptor.mipmapFilter === 'linear' &&
    descriptor.lodMaxClamp! > 0
      ? requestedAnisotropy
      : 1;
  return descriptor;
}
