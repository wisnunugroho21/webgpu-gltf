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
    if (clip > 0) {
      const rootTime = add([0, duration], 'SCALAR');
      channels.push({ sampler: samplers.length, target: { node: 0, path: 'translation' } });
      samplers.push({
        input: rootTime,
        output: add([0, 0, 0, 0, 0, duration * [0, 2.5, 5][clip]], 'VEC3'),
      });
    }
    return {
      name,
      samplers,
      channels,
      extras: {
        engine: {
          events: clip
            ? [
                { time: duration * 0.25, name: 'foot-left' },
                { time: duration * 0.75, name: 'foot-right' },
              ]
            : [],
        },
      },
    };
  });
  const aimTime = add([0, 0.5, 1], 'SCALAR');
  asset.gltf.animations.push({
    name: 'Aim',
    samplers: [
      {
        input: aimTime,
        output: add(
          [0, 0, 0, 1, -Math.SQRT1_2, 0, 0, Math.SQRT1_2, -Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          'VEC4',
        ),
      },
    ],
    channels: [3, 4].map((node) => ({ sampler: 0, target: { node, path: 'rotation' } })),
  });
  for (const material of asset.gltf.materials!) {
    material.pbrMetallicRoughness!.metallicFactor = 0;
    material.extras = { engine: { toon: { outlineWidth: 2, threshold: 0.55, shadowLevel: 0.3 } } };
  }
  // Original stylized hair and eyes; shared box geometry, no downloaded artwork.
  for (const color of [
    [0.05, 0.06, 0.12, 1],
    [0.95, 0.97, 1, 1],
  ]) {
    const material = asset.gltf.materials!.length;
    asset.gltf.materials!.push({
      pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 1 },
      extras: { engine: { toon: { outlineWidth: material === 2 ? 1 : 0 } } },
    });
    asset.gltf.meshes!.push({ primitives: [{ ...asset.gltf.meshes![0].primitives[0], material }] });
  }
  asset.gltf.nodes[2].children = [11, 12, 13, 14, 15, 16];
  asset.gltf.nodes.push(
    { mesh: 3, translation: [0, 0.85, -0.1], scale: [1.06, 0.3, 1.05] },
    ...[-0.45, 0.45].map((x) => ({ mesh: 4, translation: [x, 0, 1.01], scale: [0.3, 0.42, 0.03] })),
    ...[-0.45, 0.45].map((x) => ({
      mesh: 3,
      translation: [x, -0.05, 1.06],
      scale: [0.12, 0.3, 0.025],
    })),
    { mesh: 3, translation: [0, -0.55, 1.02], scale: [0.2, 0.03, 0.02] },
  );
  return asset;
}

export function boxAsset(): Asset {
  const asset = demoAsset();
  asset.gltf.nodes = [{ mesh: 0 }];
  asset.gltf.scenes = [{ nodes: [0] }];
  asset.gltf.materials![0].pbrMetallicRoughness!.baseColorFactor = [0.24, 0.3, 0.38, 1];
  return asset;
}
