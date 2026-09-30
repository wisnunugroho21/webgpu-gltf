import { components, decodeAccessor } from './accessors';
import type { Asset, Primitive } from './types';

// Fixed locations are shared by geometry layouts and generated WGSL.
export const locations: Record<string, number> = {
  POSITION: 0,
  NORMAL: 1,
  TEXCOORD_0: 2,
  COLOR_0: 3,
};
export interface VertexBinding {
  source: number | Float32Array;
  offset: number;
  layout: GPUVertexBufferLayout;
}
export interface Geometry {
  bindings: VertexBinding[];
  count: number;
  indices?: Uint16Array | Uint32Array;
  topology: GPUPrimitiveTopology;
  features: { normal: boolean; uv: boolean; color: number };
  positions: number[];
}

/** Produce canonical binding order independently of JSON property ordering or buffer IDs.
 * Large accessor offsets belong to setVertexBuffer; only within-record offsets enter pipelines. */
export function prepareGeometry(asset: Asset, primitive: Primitive): Geometry {
  const position = asset.gltf.accessors?.[primitive.attributes.POSITION];
  if (!position || position.type !== 'VEC3' || position.componentType !== 5126)
    throw new Error('POSITION must be a float VEC3.');
  const groups: VertexBinding[] = [];
  const features = { normal: false, uv: false, color: 0 };
  let positions: number[] = [];
  // Visit offsets in ascending order so a group's first attribute is its binding base.
  const semantics = Object.keys(locations).sort((a, b) => {
    const left = asset.gltf.accessors?.[primitive.attributes[a]];
    const right = asset.gltf.accessors?.[primitive.attributes[b]];
    return (
      (left?.bufferView ?? -1) - (right?.bufferView ?? -1) ||
      (left?.byteOffset ?? 0) - (right?.byteOffset ?? 0) ||
      locations[a] - locations[b]
    );
  });
  for (const semantic of semantics) {
    const index = primitive.attributes[semantic];
    if (index === undefined) continue;
    const accessor = asset.gltf.accessors?.[index];
    if (!accessor || accessor.count !== position.count)
      throw new Error(`Invalid ${semantic} accessor count.`);
    const width = components[accessor.type];
    if (
      ((semantic === 'POSITION' || semantic === 'NORMAL') && width !== 3) ||
      (semantic === 'TEXCOORD_0' && width !== 2) ||
      (semantic === 'COLOR_0' && width !== 3 && width !== 4)
    )
      throw new Error(`Invalid ${semantic} shape.`);
    const decoded = decodeAccessor(asset, accessor);
    if (semantic === 'POSITION') positions = decoded;
    if (semantic === 'NORMAL') features.normal = true;
    if (semantic === 'TEXCOORD_0') features.uv = true;
    if (semantic === 'COLOR_0') features.color = width;
    const view = asset.gltf.bufferViews?.[accessor.bufferView!];
    const stride = view?.byteStride ?? width * 4;
    const offset = accessor.byteOffset ?? 0;
    // Integer VEC3 formats and sparse values cannot be bound directly as WebGPU attributes.
    // Repacking those exceptional cases also keeps the shader inputs uniformly floating point.
    const direct =
      accessor.componentType === 5126 &&
      !accessor.sparse &&
      view &&
      offset % 4 === 0 &&
      stride % 4 === 0 &&
      stride <= 2048;
    let group = direct
      ? groups.find(
          (binding) =>
            binding.source === accessor.bufferView &&
            binding.layout.arrayStride === stride &&
            offset >= binding.offset &&
            offset - binding.offset + width * 4 <= stride,
        )
      : undefined;
    if (!group) {
      group = {
        source: direct ? accessor.bufferView! : new Float32Array(decoded),
        offset: direct ? offset : 0,
        layout: { arrayStride: direct ? stride : width * 4, stepMode: 'vertex', attributes: [] },
      };
      groups.push(group);
    }
    (group.layout.attributes as GPUVertexAttribute[]).push({
      shaderLocation: locations[semantic],
      offset: direct ? offset - group.offset : 0,
      format: `float32x${width}` as GPUVertexFormat,
    });
  }
  const bindings = groups;
  for (const binding of bindings)
    (binding.layout.attributes as GPUVertexAttribute[]).sort(
      (a, b) => a.shaderLocation - b.shaderLocation,
    );
  bindings.sort(
    (a, b) =>
      (a.layout.attributes as GPUVertexAttribute[])[0].shaderLocation -
      (b.layout.attributes as GPUVertexAttribute[])[0].shaderLocation,
  );

  let indices: number[] | undefined;
  if (primitive.indices !== undefined) {
    const accessor = asset.gltf.accessors?.[primitive.indices];
    if (
      !accessor ||
      accessor.type !== 'SCALAR' ||
      accessor.normalized ||
      ![5121, 5123, 5125].includes(accessor.componentType)
    )
      throw new Error('Invalid index accessor.');
    indices = decodeAccessor(asset, accessor);
    if (indices.some((i) => i >= position.count)) throw new Error('Index exceeds vertex count.');
  }
  const mode = primitive.mode ?? 4;
  const topologies: Record<number, GPUPrimitiveTopology> = {
    0: 'point-list',
    1: 'line-list',
    3: 'line-strip',
    4: 'triangle-list',
    5: 'triangle-strip',
  };
  let topology = topologies[mode];
  // WebGPU lacks line loops and triangle fans. Convert these once, outside the draw loop.
  if (mode === 2 || mode === 6) {
    const input = indices ?? Array.from({ length: position.count }, (_, i) => i);
    indices = [];
    if (mode === 2)
      for (let i = 0; i < input.length; i++) indices.push(input[i], input[(i + 1) % input.length]);
    else for (let i = 1; i + 1 < input.length; i++) indices.push(input[0], input[i], input[i + 1]);
    topology = mode === 2 ? 'line-list' : 'triangle-list';
  }
  if (!topology) throw new Error(`Unsupported primitive mode ${mode}.`);
  // uint8 indices are promoted; 0xffff is reserved for primitive restart in strips.
  const use32 = indices?.some((i) => i >= (topology.endsWith('strip') ? 65535 : 65536));
  const packed = indices
    ? use32
      ? new Uint32Array(indices)
      : new Uint16Array(indices)
    : undefined;
  return {
    bindings,
    indices: packed,
    count: packed?.length ?? position.count,
    topology,
    features,
    positions,
  };
}
