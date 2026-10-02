import { demoAsset } from '../../src/gltf/procedural/box-scene';

/** Closed, skinned and morphed original geometry for silhouette regressions. */
export function toonAsset(width = 4) {
  const asset = demoAsset();
  const add = (values: number[], type: string, bytes = false) => {
    const data = bytes ? new Uint8Array(values) : new Float32Array(values);
    const buffer = asset.buffers.length;
    asset.buffers.push(data.buffer);
    asset.gltf.buffers!.push({ byteLength: data.byteLength });
    const bufferView = asset.gltf.bufferViews!.length;
    asset.gltf.bufferViews!.push({ buffer, byteLength: data.byteLength });
    const index = asset.gltf.accessors!.length;
    asset.gltf.accessors!.push({
      bufferView,
      type,
      componentType: bytes ? 5121 : 5126,
      count: values.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[type] ?? 1),
    });
    return index;
  };
  const primitive = asset.gltf.meshes![0].primitives[0];
  primitive.attributes.JOINTS_0 = add(new Array(96).fill(0), 'VEC4', true);
  primitive.attributes.WEIGHTS_0 = add(
    Array.from({ length: 24 }, () => [1, 0, 0, 0]).flat(),
    'VEC4',
  );
  primitive.targets = [
    { POSITION: add(Array.from({ length: 24 }, () => [0, 0.2, 0]).flat(), 'VEC3') },
  ];
  asset.gltf.meshes![0].weights = [0];
  asset.gltf.nodes = [{ mesh: 0, skin: 0 }, {}];
  asset.gltf.skins = [{ joints: [1] }];
  asset.gltf.scenes = [{ nodes: [0, 1] }];
  const input = add([0, 1], 'SCALAR');
  asset.gltf.animations = [
    {
      name: 'Deform',
      samplers: [
        { input, output: add([0, 0, 0, 1, 0, Math.sin(0.2), 0, Math.cos(0.2)], 'VEC4') },
        { input, output: add([0, 1], 'SCALAR') },
      ],
      channels: [
        { sampler: 0, target: { node: 1, path: 'rotation' } },
        { sampler: 1, target: { node: 0, path: 'weights' } },
      ],
    },
  ];
  asset.gltf.materials![0] = {
    pbrMetallicRoughness: {
      baseColorFactor: [0.2, 0.6, 0.8, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    extras: { engine: { toon: { outlineColor: [1, 0, 1], outlineWidth: width } } },
  };
  return asset;
}
