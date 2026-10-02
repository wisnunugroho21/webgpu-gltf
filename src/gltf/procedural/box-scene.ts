import type { Asset } from '../types';

/** A real glTF scene generated locally: no network dependency or third-party model license.
 * Four nodes reference two meshes, exercising interleaving, shared pipelines, and instancing. */
export function demoAsset(): Asset {
  const vertices: number[] = [];
  const indices: number[] = [];
  const faces = [
    {
      n: [0, 0, 1],
      p: [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    },
    {
      n: [0, 0, -1],
      p: [
        [1, -1, -1],
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
    },
    {
      n: [1, 0, 0],
      p: [
        [1, -1, 1],
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
      ],
    },
    {
      n: [-1, 0, 0],
      p: [
        [-1, -1, -1],
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
      ],
    },
    {
      n: [0, 1, 0],
      p: [
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
        [-1, 1, -1],
      ],
    },
    {
      n: [0, -1, 0],
      p: [
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
        [-1, -1, 1],
      ],
    },
  ];
  for (const [face, { n, p }] of faces.entries()) {
    for (const position of p) vertices.push(...position, ...n);
    const base = face * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const vertexData = new Float32Array(vertices);
  const indexData = new Uint16Array(indices);
  const buffer = new ArrayBuffer(vertexData.byteLength + indexData.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(vertexData.buffer));
  new Uint8Array(buffer).set(new Uint8Array(indexData.buffer), vertexData.byteLength);
  return {
    buffers: [buffer],
    images: [],
    warnings: [],
    gltf: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: buffer.byteLength }],
      bufferViews: [
        { buffer: 0, byteLength: vertexData.byteLength, byteStride: 24 },
        { buffer: 0, byteOffset: vertexData.byteLength, byteLength: indexData.byteLength },
      ],
      accessors: [
        { bufferView: 0, type: 'VEC3', componentType: 5126, count: 24 },
        { bufferView: 0, byteOffset: 12, type: 'VEC3', componentType: 5126, count: 24 },
        { bufferView: 1, type: 'SCALAR', componentType: 5123, count: 36 },
      ],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.12, 0.65, 0.52, 1],
            metallicFactor: 0.15,
            roughnessFactor: 0.5,
          },
        },
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.85, 0.36, 0.12, 1],
            metallicFactor: 0.1,
            roughnessFactor: 0.65,
          },
        },
      ],
      meshes: [0, 1].map((material) => ({
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material }],
      })),
      nodes: [
        { mesh: 0, translation: [-1.5, 0, 0], scale: [0.8, 0.8, 0.8] },
        { mesh: 0, translation: [0.5, -0.35, 0.7], scale: [0.45, 0.45, 0.45] },
        { mesh: 0, translation: [1.6, -0.5, -0.4], scale: [0.3, 0.3, 0.3] },
        {
          mesh: 1,
          translation: [0.4, 0.7, -0.6],
          scale: [0.55, 0.55, 0.55],
          rotation: [0, 0.258819, 0, 0.965926],
        },
      ],
      scenes: [{ nodes: [0, 1, 2, 3] }],
      scene: 0,
    },
  };
}
