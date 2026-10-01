import type { Asset, Material } from '../../src/gltf/types';

/** Original flat material fixture with both UV sets and authored tangents. The optional
 * opaque background provides known radiance for transmission/absorption regressions. */
export function materialAsset(material: Material, background = false): Asset {
  const vertices = new Float32Array([
    -1, -1, 0, 0, 0, 1, 0.25, 0.25, 1, 0, 0, 1, 0.75, 0.25, 1, -1, 0, 0, 0, 1, 0.25, 0.25, 1, 0, 0,
    1, 0.75, 0.25, 1, 1, 0, 0, 0, 1, 0.25, 0.25, 1, 0, 0, 1, 0.75, 0.25, -1, 1, 0, 0, 0, 1, 0.25,
    0.25, 1, 0, 0, 1, 0.75, 0.25,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const primitive = {
    attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TANGENT: 3, TEXCOORD_1: 4 },
    indices: 5,
    material: 0,
  };
  return {
    buffers: [vertices.buffer, indices.buffer],
    images: [],
    warnings: [],
    gltf: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: vertices.byteLength }, { byteLength: indices.byteLength }],
      bufferViews: [
        { buffer: 0, byteLength: vertices.byteLength, byteStride: 56 },
        { buffer: 1, byteLength: indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, type: 'VEC3', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 12, type: 'VEC3', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 24, type: 'VEC2', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 32, type: 'VEC4', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 48, type: 'VEC2', componentType: 5126, count: 4 },
        { bufferView: 1, type: 'SCALAR', componentType: 5123, count: 6 },
      ],
      materials: [
        material,
        {
          pbrMetallicRoughness: { baseColorFactor: [0.4, 0.5, 0.6, 1] },
          extensions: { KHR_materials_unlit: {} },
        },
      ],
      meshes: [{ primitives: [primitive] }, { primitives: [{ ...primitive, material: 1 }] }],
      nodes: [
        { mesh: 0 },
        ...(background ? [{ mesh: 1, translation: [0, 0, -1], scale: [4, 4, 1] }] : []),
      ],
      scenes: [{ nodes: background ? [0, 1] : [0] }],
      scene: 0,
    },
  };
}
