import { expect, test } from 'vitest';
import { AssetRegistry, World, captureSaveState, loadSaveState } from '../src/engine';
import type { Asset } from '../src/gltf/types';
import { animatedAsset } from './fixtures/animated';
import type { AnimationCheckpoint } from '../src/animation/controller';
import { Pose } from '../src/scene/pose';
import { collectInstances, selectedSceneNodes } from '../src/gltf/scene';

test('deep model hierarchies preserve traversal order and propagate root overrides without recursion', () => {
  const depth = 10_000;
  const asset: Asset = {
    gltf: {
      asset: { version: '2.0' },
      nodes: Array.from({ length: depth }, (_, index) =>
        index + 1 < depth ? { children: [index + 1] } : {},
      ),
    },
    buffers: [],
    images: [],
    warnings: [],
  };
  const pose = new Pose(asset);
  expect(selectedSceneNodes(asset.gltf)).toEqual(Array.from({ length: depth }, (_, i) => i));
  expect(collectInstances(asset.gltf).size).toBe(0);
  pose.setNodeTransform(0, { translation: [2, 3, 4] });
  expect([...pose.nodes[depth - 1].world].slice(12, 15)).toEqual([2, 3, 4]);
  pose.clearNodeTransform(0);
  expect([...pose.nodes[depth - 1].world].slice(12, 15)).toEqual([0, 0, 0]);
});

test('matrix-authored nodes can be inspected and saved without granting TRS ownership', async () => {
  const asset: Asset = {
    gltf: {
      asset: { version: '2.0' },
      nodes: [{ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1] }],
    },
    buffers: [],
    images: [],
    warnings: [],
  };
  const assets = new AssetRegistry();
  assets.register('matrix', asset, 'fixture:matrix');
  const world = new World(assets);
  const model = world.createEntity({ id: 'matrix', model: { asset: 'matrix' } }).model!;
  expect(model.getNodeOverride(0)).toEqual({});
  expect(() => model.setNodeOverride(0, { translation: [1, 2, 3] })).toThrow('TRS');
  expect(() => model.getNodeOverride(99)).toThrow('Unknown model node');
  const saved = captureSaveState(world);
  expect(saved.models.matrix.overrides).toEqual({});
  const restored = await loadSaveState(saved, { assets });
  expect([...restored.world.getEntity('matrix').model!.pose.nodes[0].world]).toEqual([
    ...model.pose.nodes[0].world,
  ]);
  assets.destroy();
});

test('world exports and saves include only assets referenced by that world', async () => {
  const assets = new AssetRegistry();
  assets.register('hero', animatedAsset(), 'fixture:hero');
  assets.register('other-level', animatedAsset(), 'unavailable:other-level');
  const world = new World(assets);
  world.createEntity({ id: 'hero', model: { asset: 'hero' } });
  const saved = captureSaveState(world);
  expect(saved.scene.assets).toEqual({ hero: 'fixture:hero' });
  const requested: string[] = [];
  const restoredAssets = new AssetRegistry({
    resolve: async (uri) => {
      requested.push(uri);
      if (uri !== 'fixture:hero') throw new Error('Unrelated asset must not be loaded');
      return animatedAsset();
    },
  });
  await loadSaveState(saved, { assets: restoredAssets });
  expect(requested).toEqual(['fixture:hero']);
  expect(assets.references()['other-level']).toBe('unavailable:other-level');
  restoredAssets.destroy();
  assets.destroy();
});

test('checkpoint restore rejects a layer missing its clip without changing playback', () => {
  const assets = new AssetRegistry();
  assets.register('hero', animatedAsset(), 'fixture:hero');
  const world = new World(assets);
  const animation = world.createEntity({ id: 'hero', model: { asset: 'hero' } }).model!.animation;
  const before = animation.checkpoint();
  const malformed = structuredClone(before);
  Reflect.deleteProperty(malformed.layers[0], 'clip');
  expect(() => animation.restore(malformed)).toThrow();
  expect(animation.checkpoint()).toEqual(before);
  assets.destroy();
});

test.each([
  { fade: null },
  { fade: { duration: 1, elapsed: 0, source: [], snapshot: null } },
  { fade: { duration: 1, elapsed: 0, source: [], unknown: true } },
  { events: [null] },
  { rootMotion: null },
  { layers: [{ clip: 0, time: 0, weight: 1, mask: {} }] },
  { displacement: new Array(3) },
])('malformed checkpoint fields fail atomically: %j', (patch) => {
  const assets = new AssetRegistry();
  assets.register('hero', animatedAsset(), 'fixture:hero');
  const world = new World(assets);
  const animation = world.createEntity({ id: 'hero', model: { asset: 'hero' } }).model!.animation;
  const before = animation.checkpoint();
  expect(() =>
    animation.restore({ ...before, ...patch } as unknown as AnimationCheckpoint),
  ).toThrow();
  expect(animation.checkpoint()).toEqual(before);
  assets.destroy();
});
