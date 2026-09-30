import type { Accessor, Asset } from './types';

export const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function read(view: DataView, offset: number, type: number, normalized = false): number {
  switch (type) {
    case 5120: {
      const n = view.getInt8(offset);
      return normalized ? Math.max(n / 127, -1) : n;
    }
    case 5121: {
      const n = view.getUint8(offset);
      return normalized ? n / 255 : n;
    }
    case 5122: {
      const n = view.getInt16(offset, true);
      return normalized ? Math.max(n / 32767, -1) : n;
    }
    case 5123: {
      const n = view.getUint16(offset, true);
      return normalized ? n / 65535 : n;
    }
    case 5125:
      return view.getUint32(offset, true);
    case 5126:
      return view.getFloat32(offset, true);
    default:
      throw new Error(`Unsupported accessor component type ${type}.`);
  }
}

function source(
  asset: Asset,
  viewIndex: number,
  offset: number,
  count: number,
  stride: number,
  elementSize: number,
): DataView {
  const view = asset.gltf.bufferViews?.[viewIndex];
  if (
    !view ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset + (count ? (count - 1) * stride + elementSize : 0) > view.byteLength
  )
    throw new Error('Accessor exceeds its bufferView.');
  return new DataView(
    asset.buffers[view.buffer],
    (view.byteOffset ?? 0) + offset,
    view.byteLength - offset,
  );
}

/** Decode only for bounds, unsupported GPU formats, sparse overlays, and index conversion.
 * Ordinary float attributes still use the original bufferView on the GPU. */
export function decodeAccessor(asset: Asset, accessor: Accessor): number[] {
  const width = components[accessor.type];
  const size = sizes[accessor.componentType];
  if (!width || !size || !Number.isInteger(accessor.count) || accessor.count < 1)
    throw new Error('Invalid accessor shape.');
  const result = new Array<number>(accessor.count * width).fill(0);
  if (accessor.bufferView !== undefined) {
    const stride = asset.gltf.bufferViews?.[accessor.bufferView]?.byteStride ?? width * size;
    if (stride < width * size || stride % size) throw new Error('Invalid accessor stride.');
    const view = source(
      asset,
      accessor.bufferView,
      accessor.byteOffset ?? 0,
      accessor.count,
      stride,
      width * size,
    );
    for (let i = 0; i < accessor.count; i++)
      for (let c = 0; c < width; c++)
        result[i * width + c] = read(
          view,
          i * stride + c * size,
          accessor.componentType,
          accessor.normalized,
        );
  } else if (!accessor.sparse)
    throw new Error('Accessor has neither a bufferView nor sparse data.');
  const sparse = accessor.sparse;
  if (sparse) {
    if (
      sparse.count < 1 ||
      sparse.count > accessor.count ||
      ![5121, 5123, 5125].includes(sparse.indices.componentType)
    )
      throw new Error('Invalid sparse accessor.');
    const indexSize = sizes[sparse.indices.componentType];
    const indices = source(
      asset,
      sparse.indices.bufferView,
      sparse.indices.byteOffset ?? 0,
      sparse.count,
      indexSize,
      indexSize,
    );
    const values = source(
      asset,
      sparse.values.bufferView,
      sparse.values.byteOffset ?? 0,
      sparse.count,
      width * size,
      width * size,
    );
    let previous = -1;
    for (let i = 0; i < sparse.count; i++) {
      const index = read(indices, i * indexSize, sparse.indices.componentType);
      if (index <= previous || index >= accessor.count)
        throw new Error('Sparse indices must increase and fit the accessor.');
      previous = index;
      for (let c = 0; c < width; c++)
        result[index * width + c] = read(
          values,
          (i * width + c) * size,
          accessor.componentType,
          accessor.normalized,
        );
    }
  }
  if (result.some((value) => !Number.isFinite(value)))
    throw new Error('Accessor contains a non-finite value.');
  return result;
}
