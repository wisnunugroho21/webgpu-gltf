import type { Accessor, Gltf } from '../types';
import { components, componentSizes } from '../accessors';
import { integer, ref, vector, object } from './fields';

export function validateAccessorMetadata(gltf: Gltf, accessor: Accessor): void {
  integer(accessor.count, 1);
  integer(accessor.byteOffset ?? 0);
  const width = components[accessor.type],
    size = componentSizes[accessor.componentType];
  if (!width || !size || (accessor.type === 'MAT4' && accessor.componentType !== 5126))
    throw new Error('Unsupported accessor shape.');
  if (accessor.normalized !== undefined && typeof accessor.normalized !== 'boolean')
    throw new Error('Invalid accessor normalized flag.');
  if (accessor.normalized && [5125, 5126].includes(accessor.componentType))
    throw new Error('Invalid normalized component type.');
  const range = (
    index: number,
    offset: number,
    count: number,
    element: number,
    alignment: number,
    packed = false,
  ) => {
    ref(index, gltf.bufferViews);
    integer(offset);
    const view = gltf.bufferViews![index],
      stride = packed ? element : (view.byteStride ?? element);
    if (
      stride < element ||
      stride % alignment ||
      offset % alignment ||
      ((view.byteOffset ?? 0) + offset) % alignment ||
      offset + (count - 1) * stride + element > view.byteLength ||
      (packed && view.byteStride !== undefined)
    )
      throw new Error('Invalid accessor bufferView range, alignment or stride.');
  };
  if (accessor.bufferView !== undefined)
    range(accessor.bufferView, accessor.byteOffset ?? 0, accessor.count, width * size, size);
  for (const name of ['min', 'max'] as const)
    if (accessor[name] !== undefined) vector(accessor[name], width);
  if (accessor.min && accessor.max && accessor.min.some((v, i) => v > accessor.max![i]))
    throw new Error('Accessor min exceeds max.');
  if (accessor.sparse) {
    const sparse = accessor.sparse;
    object(sparse);
    object(sparse.indices);
    object(sparse.values);
    integer(sparse.count, 1);
    if (sparse.count > accessor.count || ![5121, 5123, 5125].includes(sparse.indices.componentType))
      throw new Error('Invalid sparse accessor.');
    const indexSize = componentSizes[sparse.indices.componentType];
    range(
      sparse.indices.bufferView,
      sparse.indices.byteOffset ?? 0,
      sparse.count,
      indexSize,
      indexSize,
      true,
    );
    range(
      sparse.values.bufferView,
      sparse.values.byteOffset ?? 0,
      sparse.count,
      width * size,
      size,
      true,
    );
  }
  // URI-less Draco accessors are legal; their primitive references are checked below.
}
