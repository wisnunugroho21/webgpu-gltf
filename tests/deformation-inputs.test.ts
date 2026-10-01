import { expect, test } from 'vitest';
import { Pose } from '../src/gltf/animation';
import { Deformation } from '../src/gltf/deformation';
import { DeformationInputCache } from '../src/gltf/deformation-inputs';
import { animatedAsset } from './fixtures/animated';

test('nodes share decoded bases, morph deltas and bounds while CPU outputs and weights remain independent', () => {
  const asset = animatedAsset(),
    pose = new Pose(asset);
  const primitive = asset.gltf.meshes![0].primitives[0];
  const cache = new DeformationInputCache(asset);
  const a = new Deformation(asset, primitive, 0, pose, cache);
  const b = new Deformation(asset, primitive, 3, pose, cache);
  expect(a.inputs).toBe(b.inputs);
  for (let i = 0; i < a.streams.length; i++) {
    expect(a.streams[i].base).toBe(b.streams[i].base);
    expect(a.streams[i].targets).toBe(b.streams[i].targets);
    expect(a.streams[i].values).not.toBe(b.streams[i].values);
  }
  const original = [...a.streams[0].base];
  const bOutput = [...b.streams[0].values];
  pose.nodes[0].weights[0] = -0.5;
  a.update();
  expect([...b.streams[0].values]).toEqual(bOutput);
  expect([...a.streams[0].base]).toEqual(original);
  expect(a.streams[0].values[7]).toBe(1.5);
  expect(b.streams[0].values[7]).toBe(2.75);
});

test('different skins share primitive influences but retain independent palettes and validate every joint range', () => {
  const asset = animatedAsset();
  asset.gltf.skins!.push({ joints: [2, 1] }, { joints: [1] });
  asset.gltf.nodes![3].skin = 1;
  const pose = new Pose(asset),
    primitive = asset.gltf.meshes![0].primitives[0];
  const cache = new DeformationInputCache(asset);
  const a = new Deformation(asset, primitive, 0, pose, cache);
  const b = new Deformation(asset, primitive, 3, pose, cache);
  expect(a.influences).toBe(b.influences);
  expect(a.palette).not.toBe(b.palette);
  expect(a.palette[0]).not.toBe(b.palette[0]);
  asset.gltf.nodes![3].skin = 2;
  expect(() => new Deformation(asset, primitive, 3, pose, cache)).toThrow('range');
  // A smaller skin must not invalidate the cached raw influences for compatible skins.
  expect(() => new Deformation(asset, primitive, 0, pose, cache)).not.toThrow();
});

test('cache identity isolates distinct primitives and assets, and skin validation remains lazy for morph-only nodes', () => {
  const asset = animatedAsset(),
    primitive = asset.gltf.meshes![0].primitives[0];
  delete asset.gltf.nodes![0].skin;
  delete primitive.attributes.WEIGHTS_0;
  const pose = new Pose(asset),
    cache = new DeformationInputCache(asset);
  const a = new Deformation(asset, primitive, 0, pose, cache);
  const b = new Deformation(asset, primitive, 3, pose, cache);
  expect(a.influences).toBe(b.influences);
  expect(a.influences).toHaveLength(0);
  expect(cache.get({ ...primitive })).not.toBe(a.inputs);
  const other = animatedAsset();
  expect(new DeformationInputCache(other).get(other.gltf.meshes![0].primitives[0])).not.toBe(
    a.inputs,
  );
  asset.gltf.nodes![0].skin = 0;
  expect(() => new Deformation(asset, primitive, 0, pose, cache)).toThrow('attributes');
});
