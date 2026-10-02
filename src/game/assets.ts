import { demoAsset } from '../gltf/procedural/box-scene';
import type { Asset, Animation } from '../gltf/types';

/** Original block character. Shared glTF geometry and clips, per-instance poses.
 * Morph breathing also exercises independent compute outputs in the playable app. */
export function characterAsset(): Asset {
  const asset = demoAsset();
  const add = (values: number[], type: 'SCALAR' | 'VEC3' | 'VEC4') => {
    const data = new Float32Array(values),
      buffer = asset.buffers.length;
    asset.buffers.push(data.buffer);
    asset.gltf.buffers!.push({ byteLength: data.byteLength });
    const view = asset.gltf.bufferViews!.length;
    asset.gltf.bufferViews!.push({ buffer, byteLength: data.byteLength });
    const index = asset.gltf.accessors!.length;
    asset.gltf.accessors!.push({
      bufferView: view,
      componentType: 5126,
      type,
      count: values.length / (type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4),
    });
    return index;
  };
  const breathing = add(Array.from({ length: 24 }, () => [0, 0.03, 0]).flat(), 'VEC3');
  asset.gltf.meshes!.push({
    weights: [0],
    primitives: [{ ...asset.gltf.meshes![0].primitives[0], targets: [{ POSITION: breathing }] }],
  });
  asset.gltf.nodes = [
    { children: [1, 2, 3, 4, 5, 6] },
    { mesh: 2, translation: [0, 1.15, 0], scale: [0.3, 0.4, 0.2] },
    { mesh: 1, translation: [0, 1.8, 0], scale: [0.25, 0.25, 0.25] },
    { translation: [-0.42, 1.45, 0], children: [7] },
    { translation: [0.42, 1.45, 0], children: [8] },
    { translation: [-0.17, 0.75, 0], children: [9] },
    { translation: [0.17, 0.75, 0], children: [10] },
    ...[3, 4, 5, 6].map((_, i) => ({
      mesh: 0,
      translation: [0, -0.32, 0],
      scale: [i < 2 ? 0.1 : 0.13, 0.32, 0.13],
    })),
  ];
  asset.gltf.scenes = [{ nodes: [0] }];
  asset.gltf.animations = ['Idle', 'Walk', 'Run'].map((name, clip) => {
    const duration = [2, 1, 0.6][clip];
    const input = add([0, duration / 4, duration / 2, (duration * 3) / 4, duration], 'SCALAR');
    const samplers = [{ input, output: add([0, 1, 0, 1, 0], 'SCALAR') }];
    const channels: Animation['channels'] = [{ sampler: 0, target: { node: 1, path: 'weights' } }];
    for (let limb = 3; limb <= 6; limb++) {
      const amplitude = [0.03, 0.45, 0.8][clip] * (limb % 2 ? 1 : -1) * (limb < 5 ? -1 : 1);
      const output = add(
        [0, amplitude, 0, -amplitude, 0].flatMap((a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]),
        'VEC4',
      );
      channels.push({ sampler: samplers.length, target: { node: limb, path: 'rotation' } });
      samplers.push({ input, output });
    }
    return { name, samplers, channels };
  });
  return asset;
}

export function boxAsset(): Asset {
  const asset = demoAsset();
  asset.gltf.nodes = [{ mesh: 0 }];
  asset.gltf.scenes = [{ nodes: [0] }];
  asset.gltf.materials![0].pbrMetallicRoughness!.baseColorFactor = [0.24, 0.3, 0.38, 1];
  return asset;
}
