import { mat4 } from 'gl-matrix';
import type { Asset } from '../../src/gltf/types';

/** Small original fixture shared by CPU and browser tests; no network or model license needed. */
export function animatedAsset(): Asset {
  const asset: Asset = {
    gltf: { asset: { version: '2.0' }, accessors: [], bufferViews: [], buffers: [] },
    buffers: [],
    images: [],
    warnings: [],
  };
  const add = (values: number[], type: string, componentType = 5126) => {
    const data = componentType === 5121 ? new Uint8Array(values) : new Float32Array(values);
    const buffer = asset.buffers.length;
    asset.buffers.push(data.buffer);
    asset.gltf.buffers!.push({ byteLength: data.byteLength });
    const bufferView = asset.gltf.bufferViews!.length;
    asset.gltf.bufferViews!.push({ buffer, byteLength: data.byteLength });
    const accessor = asset.gltf.accessors!.length;
    asset.gltf.accessors!.push({
      bufferView,
      type,
      componentType,
      count: values.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type] ?? 1),
    });
    return accessor;
  };
  const position = add([-0.5, 0, 0, 0.5, 0, 0, 0, 2, 0], 'VEC3');
  const normal = add([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3');
  const tangent = add([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1], 'VEC4');
  const joints = add([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 'VEC4', 5121);
  const weights = add([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 'VEC4');
  const target = add([0, 0, 0, 0, 0, 0, 0, 1, 0], 'VEC3');
  const normalDelta = add([0.2, 0, 0, 0.2, 0, 0, 0.2, 0, 0], 'VEC3');
  const tangentDelta = add([0, 0.2, 0, 0, 0.2, 0, 0, 0.2, 0], 'VEC3');
  const bind = mat4.fromTranslation(mat4.create(), [0, -1, 0]);
  const inverseBind = add([...mat4.create(), ...bind], 'MAT4');
  const times = add([0, 2], 'SCALAR');
  const rotation = add([0, 0, 0, 1, 0, 0, 1, 0], 'VEC4');
  const morphWeights = add([0, 1], 'SCALAR');
  const translation = add([2, 0, 0, 3, 0, 0], 'VEC3');
  asset.gltf.meshes = [
    {
      weights: [0.25],
      primitives: [
        {
          attributes: {
            POSITION: position,
            NORMAL: normal,
            TANGENT: tangent,
            JOINTS_0: joints,
            WEIGHTS_0: weights,
          },
          targets: [{ POSITION: target, NORMAL: normalDelta, TANGENT: tangentDelta }],
          material: 0,
        },
      ],
    },
  ];
  asset.gltf.materials = [
    {
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [0.1, 0.65, 0.4, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    },
  ];
  asset.gltf.nodes = [
    { mesh: 0, skin: 0, translation: [10, 0, 0], weights: [0] },
    { children: [2] },
    { translation: [0, 1, 0] },
    { mesh: 0, translation: [2, 0, 0], weights: [0.75] },
  ];
  asset.gltf.skins = [{ joints: [1, 2], inverseBindMatrices: inverseBind }];
  asset.gltf.scenes = [{ nodes: [0, 1, 3] }];
  asset.gltf.scene = 0;
  asset.gltf.animations = [
    {
      name: 'Joint rotation',
      samplers: [{ input: times, output: rotation }],
      channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
    },
    {
      name: 'Morph weights',
      samplers: [{ input: times, output: morphWeights }],
      channels: [
        { sampler: 0, target: { node: 0, path: 'weights' } },
        { sampler: 0, target: { node: 3, path: 'weights' } },
      ],
    },
    {
      name: 'Node translation',
      samplers: [{ input: times, output: translation }],
      channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }],
    },
  ];
  return asset;
}
