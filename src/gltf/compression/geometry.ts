import { components } from '../accessors';
import type { Accessor, Gltf } from '../types';
import type { CompressionRuntime, DracoAttribute } from './runtime';
import { AssetBudget, assetLimits, checkLimit } from '../limits';

/** Copy the exact compressed range before transferring it to a worker. Other views may
 * share its backing buffer, so transferring the asset's original buffer is unsafe. */
export function bufferRange(
  buffers: ArrayBuffer[],
  buffer: number,
  offset: number,
  length: number,
): ArrayBuffer {
  if (
    !Number.isSafeInteger(buffer) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    !buffers[buffer] ||
    offset + length > buffers[buffer].byteLength
  )
    throw new Error('Compressed data exceeds its source buffer.');
  return buffers[buffer].slice(offset, offset + length);
}

/** Decode bufferViews first: meshopt can contain animation, sparse data and morph deltas
 * as well as geometry. Replacing the view preserves every accessor's offset/stride. */
export async function decodeMeshopt(
  gltf: Gltf,
  buffers: ArrayBuffer[],
  budget = new AssetBudget(assetLimits(), '<meshopt>'),
  signal?: AbortSignal,
) {
  const views = (gltf.bufferViews ?? []).filter((view) => view.extensions?.EXT_meshopt_compression);
  if (!views.length) return;
  const { MeshoptDecoder } = await import('meshoptimizer/decoder');
  if (!MeshoptDecoder.supported) throw new Error('Meshopt requires WebAssembly support.');
  await MeshoptDecoder.ready;
  for (const view of views) {
    signal?.throwIfAborted();
    const ext = view.extensions!.EXT_meshopt_compression!;
    const mode = ext.mode,
      filter = ext.filter ?? 'NONE';
    if (
      !Number.isSafeInteger(ext.count) ||
      ext.count < 1 ||
      !Number.isSafeInteger(ext.byteStride) ||
      ext.byteStride < 1 ||
      ext.count * ext.byteStride !== view.byteLength ||
      (view.byteStride !== undefined && view.byteStride !== ext.byteStride) ||
      !['ATTRIBUTES', 'TRIANGLES', 'INDICES'].includes(mode) ||
      !['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL'].includes(filter) ||
      (mode === 'ATTRIBUTES' && (ext.byteStride % 4 !== 0 || ext.byteStride > 256)) ||
      (mode !== 'ATTRIBUTES' && (![2, 4].includes(ext.byteStride) || filter !== 'NONE')) ||
      (mode === 'TRIANGLES' && ext.count % 3 !== 0) ||
      (filter === 'OCTAHEDRAL' && ![4, 8].includes(ext.byteStride)) ||
      (filter === 'QUATERNION' && ext.byteStride !== 8)
    )
      throw new Error('Invalid EXT_meshopt_compression metadata.');
    const source = bufferRange(buffers, ext.buffer, ext.byteOffset ?? 0, ext.byteLength);
    budget.decodedBytes(
      view.byteLength,
      `bufferViews[${gltf.bufferViews!.indexOf(view)}].extensions.EXT_meshopt_compression`,
    );
    const decoded = new Uint8Array(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(
      decoded,
      ext.count,
      ext.byteStride,
      new Uint8Array(source),
      mode,
      filter,
    );
    view.buffer = buffers.push(decoded.buffer) - 1;
    view.byteOffset = 0;
    delete view.extensions!.EXT_meshopt_compression;
  }
}

function appendAccessor(
  gltf: Gltf,
  buffers: ArrayBuffer[],
  accessor: Accessor,
  data: ArrayBuffer,
): number {
  const view =
    (gltf.bufferViews ??= []).push({
      buffer: buffers.push(data) - 1,
      byteLength: data.byteLength,
    }) - 1;
  // A decoded accessor is primitive-specific. Clone instead of overwriting an accessor
  // shared with another primitive or its uncompressed fallback. Keep normalization.
  const copy = { ...accessor, bufferView: view, byteOffset: 0 };
  delete copy.sparse;
  return gltf.accessors!.push(copy) - 1;
}

export async function decodeDraco(
  gltf: Gltf,
  buffers: ArrayBuffer[],
  runtime: CompressionRuntime,
  budget = new AssetBudget(assetLimits(), '<draco>'),
  signal?: AbortSignal,
) {
  for (const mesh of gltf.meshes ?? [])
    for (const primitive of mesh.primitives) {
      signal?.throwIfAborted();
      const ext = primitive.extensions?.KHR_draco_mesh_compression;
      if (!ext) continue;
      const mode = primitive.mode ?? 4;
      if (mode !== 4 && mode !== 5) throw new Error('Draco requires triangle primitives.');
      const view = gltf.bufferViews?.[ext.bufferView];
      if (!view) throw new Error('Draco references a missing bufferView.');
      const attributes: Record<string, DracoAttribute> = {};
      for (const [name, id] of Object.entries(ext.attributes)) {
        const accessor = gltf.accessors?.[primitive.attributes[name]];
        if (!accessor || !components[accessor.type] || !Number.isSafeInteger(id) || id < 0)
          throw new Error(`Invalid Draco ${name} attribute.`);
        attributes[name] = {
          id,
          componentType: accessor.componentType,
          count: accessor.count,
          width: components[accessor.type],
        };
      }
      if (!Object.keys(attributes).length) throw new Error('Draco has no compressed attributes.');
      const path = `meshes[${gltf.meshes!.indexOf(mesh)}].primitives[${mesh.primitives.indexOf(primitive)}].extensions.KHR_draco_mesh_compression`;
      const bytesPerComponent: Record<number, number> = {
        5120: 1,
        5121: 1,
        5122: 2,
        5123: 2,
        5125: 4,
        5126: 4,
      };
      for (const config of Object.values(attributes))
        budget.decodedBytes(
          config.count * config.width * bytesPerComponent[config.componentType],
          path,
        );
      const declaredIndices =
        primitive.indices === undefined ? undefined : gltf.accessors?.[primitive.indices];
      const maxIndices = declaredIndices
        ? mode === 5
          ? Math.max(0, declaredIndices.count - 2) * 3
          : declaredIndices.count
        : budget.limits.maxAccessorValues;
      budget.at(path, () => {
        checkLimit(
          (gltf.accessors?.length ?? 0) + Object.keys(attributes).length + 1,
          budget.limits.maxDefinitions,
          'decoded accessors',
        );
        checkLimit(
          (gltf.bufferViews?.length ?? 0) + Object.keys(attributes).length + 1,
          budget.limits.maxDefinitions,
          'decoded bufferViews',
        );
      });
      const result = await runtime
        .draco(
          bufferRange(buffers, view.buffer, view.byteOffset ?? 0, view.byteLength),
          attributes,
          Math.min(maxIndices, Math.floor(budget.remainingDecodedBytes / 4)),
        )
        .catch((error) => {
          return budget.at(path, () => {
            throw error;
          });
        });
      signal?.throwIfAborted();
      budget.decodedBytes(result.indices.byteLength, path);
      for (const [name, data] of Object.entries(result.attributes))
        primitive.attributes[name] = appendAccessor(
          gltf,
          buffers,
          gltf.accessors![primitive.attributes[name]],
          data,
        );
      const index =
        primitive.indices === undefined ? undefined : gltf.accessors?.[primitive.indices];
      if (
        primitive.indices !== undefined &&
        (!index ||
          index.type !== 'SCALAR' ||
          index.normalized ||
          ![5121, 5123, 5125].includes(index.componentType) ||
          (mode === 4 && index.count !== result.indices.length))
      )
        throw new Error('Draco indices do not match their accessor.');
      // Draco returns triangle-list indices even when the source primitive was a strip.
      // Promote to uint32 so the decoder's vertex indices cannot wrap during narrowing.
      primitive.indices = appendAccessor(
        gltf,
        buffers,
        { componentType: 5125, count: result.indices.length, type: 'SCALAR' },
        result.indices.buffer,
      );
      primitive.mode = 4;
      delete primitive.extensions!.KHR_draco_mesh_compression;
    }
}
