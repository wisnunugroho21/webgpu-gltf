import type { Accessor, Gltf } from './types';

/** Quantization's scale/offset is already expressed by node transforms, skin inverse
 * binds and texture transforms. Normalized integers only need accessor conversion. */
export function quantizedAttribute(gltf: Gltf, accessor: Accessor, morph = false): boolean {
  const declared = [...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])].includes(
    'KHR_mesh_quantization',
  );
  return (
    declared && (morph ? [5120, 5122] : [5120, 5121, 5122, 5123]).includes(accessor.componentType)
  );
}
