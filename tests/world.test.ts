import { expect, test, vi } from 'vitest';
import {
  World,
  ModelLibrary,
  ModelInstance,
  LoadedModel,
  loadWorld,
  parseSceneDocument,
} from '../src/engine';
import { animatedAsset } from './fixtures/animated';

function library() {
  const asset = animatedAsset();
  const models = new ModelLibrary();
  models.register('hero', asset, 'models/hero.glb');
  return { models, asset };
}

test('one entity instantiates every model node and instances retain independent playback', async () => {
  const asset = animatedAsset();
  const authored = JSON.stringify(asset.gltf);
  const resolve = vi.fn(async () => asset);
  const world = await loadWorld(
    {
      version: 1,
      assets: { hero: 'hero.glb' },
      entities: [
        { id: 'player', model: { asset: 'hero' }, transform: { translation: [5, 0, 0] } },
        { id: 'npc', model: { asset: 'hero' }, transform: { translation: [-5, 0, 0] } },
      ],
    },
    resolve,
  );
  expect(resolve).toHaveBeenCalledTimes(1);
  const player = world.getEntity('player').model!,
    npc = world.getEntity('npc').model!;
  expect(player.asset).toBe(npc.asset);
  expect(player.resources).toBe(npc.resources);
  expect(player.pose.clips).toBe(npc.pose.clips);
  expect(player.animation).not.toBe(npc.animation);
  expect(player.pose).not.toBe(npc.pose);
  expect(player.pose.nodes).toHaveLength(4);
  expect(world.entities).toHaveLength(2);
  player.animation.setPlaying(false);
  npc.animation.setPlaying(false);
  player.animation.select(2);
  player.animation.seek(2);
  npc.animation.select(1);
  npc.animation.seek(2);
  world.update(0);
  expect(player.pose.nodes[3].world[12]).toBe(8);
  expect(npc.pose.nodes[3].world[12]).toBe(-3);
  expect(player.pose.nodes[0].weights).toEqual([0]);
  expect(npc.pose.nodes[0].weights).toEqual([1]);
  const revision = world.poseRevision;
  world.update(0);
  expect(world.poseRevision).toBe(revision);
  player.animation.select(-1);
  world.update(0);
  expect(player.pose.nodes[3].world[12]).toBe(7);
  expect(world.getEntity('player').transform.translation).toEqual([5, 0, 0]);
  expect(JSON.stringify(asset.gltf)).toBe(authored);
});

test('loaded models share frozen prepared clips while aliases and direct instances keep independent poses', () => {
  const { models, asset } = library();
  models.register('alias', asset, 'alias.glb');
  expect(models.get('hero')).toBe(asset);
  expect(models.getModel('hero')).toBe(models.getModel('alias'));
  const loaded = new LoadedModel(asset);
  const a = new ModelInstance('hero', loaded),
    b = new ModelInstance('hero', loaded);
  expect(a.pose.clips).toBe(b.pose.clips);
  expect(a.pose.clips).toBe(loaded.clips);
  expect(a.pose.nodes[0].weights).not.toBe(b.pose.nodes[0].weights);
  expect(a.pose.nodes[0].world).not.toBe(b.pose.nodes[0].world);
  const track = loaded.clips[0].tracks[0];
  expect(Object.isFrozen(track.times) && Object.isFrozen(track.values)).toBe(true);
  expect(() => {
    track.values[0] = 999;
  }).toThrow();
  expect(() => {
    track.node = 999;
  }).toThrow();
  expect(new ModelInstance('standalone', animatedAsset()).asset.gltf.asset.version).toBe('2.0');
});

test('entity parents are separate from model parents and root movement updates joints', () => {
  const { models } = library();
  const world = new World(models);
  const group = world.createEntity({ id: 'group', transform: { translation: [10, 0, 0] } });
  const player = world.createEntity({
    id: 'player',
    parent: 'group',
    model: { asset: 'hero' },
    transform: { translation: [5, 0, 0] },
  });
  world.update(0);
  expect(player.worldMatrix[12]).toBe(15);
  expect(player.model!.pose.nodes[2].world[12]).toBe(15);
  expect(player.model!.pose.nodes[3].world[12]).toBe(17);
  const revision = player.model!.pose.nodes[2].worldRevision;
  group.setTransform({ translation: [20, 0, 0] });
  world.update(0);
  expect(player.model!.pose.nodes[2].world[12]).toBe(25);
  expect(player.model!.pose.nodes[2].worldRevision).toBe(revision + 1);
  expect(() => world.setParent('group', 'player')).toThrow('Cycle');
  world.setParent('player');
  world.update(0);
  expect(player.model!.pose.nodes[2].world[12]).toBe(5);
  const poses = world.poseRevision;
  world.update(0);
  expect(world.poseRevision).toBe(poses);
});

test('scene round trips preserve gameplay data and asset references without glTF payloads', () => {
  const { models } = library();
  const world = World.fromDocument(
    {
      version: 1,
      assets: { hero: 'models/hero.glb' },
      entities: [
        {
          id: 'player',
          parent: 'group',
          model: { asset: 'hero' },
          components: { health: { current: 50, max: 100 }, tags: ['friendly'] },
        },
        { id: 'group', name: 'Party', transform: { translation: [2, 0, 0] } },
      ],
    },
    models,
  );
  const saved = JSON.stringify(world.toDocument());
  const restored = World.fromDocument(saved, models);
  expect(restored.toDocument()).toEqual(world.toDocument());
  expect(restored.getEntity('player').getComponent('health')).toEqual({ current: 50, max: 100 });
  expect(saved).not.toMatch(/"(?:nodes|buffers|skins|animations|accessors)"/);
  expect(restored.getEntity('player').worldMatrix[12]).toBe(2);
});

test('transform and component boundaries copy values, validate atomically and support mirrored placement', () => {
  const world = new World();
  const input = { translation: [1, 2, 3] };
  const entity = world.createEntity({ id: 'gameplay-only', transform: input });
  input.translation[0] = 99;
  const copy = entity.transform;
  copy.translation[0] = 99;
  expect(entity.transform.translation).toEqual([1, 2, 3]);
  expect(() => entity.setTransform({ scale: [0, 1, 1] })).toThrow();
  expect(entity.transform.scale).toEqual([1, 1, 1]);
  entity.setTransform({ scale: [-1, 2, 3], rotation: [0, 0, 0, 2] });
  expect(entity.transform.rotation).toEqual([0, 0, 0, 1]);
  const health = { current: 20 };
  entity.setComponent('health', health);
  health.current = 90;
  const healthCopy = entity.getComponent('health') as { current: number };
  healthCopy.current = 80;
  expect(entity.getComponent('health')).toEqual({ current: 20 });
  expect(() => entity.setComponent('health', { current: NaN })).toThrow();
  expect(entity.getComponent('health')).toEqual({ current: 20 });
  entity.removeComponent('health');
  expect(entity.getComponent('health')).toBeUndefined();
});

test('invalid scene documents fail before loading any referenced model', async () => {
  const resolve = vi.fn(async () => animatedAsset());
  for (const document of [
    { version: 2, assets: {}, entities: [] },
    { version: 1, assets: {}, entities: [{ id: 'a' }, { id: 'a' }] },
    { version: 1, assets: {}, entities: [{ id: 'a', parent: 'b' }] },
    {
      version: 1,
      assets: {},
      entities: [
        { id: 'a', parent: 'b' },
        { id: 'b', parent: 'a' },
      ],
    },
    { version: 1, assets: {}, entities: [{ id: 'a', model: { asset: 'missing' } }] },
    { version: 1, assets: {}, entities: [{ id: 'a', transform: { rotation: [0, 0, 0, 0] } }] },
    { version: 1, assets: {}, entities: [{ id: 'a', components: { value: undefined } }] },
  ])
    await expect(loadWorld(document, resolve)).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  expect(() => parseSceneDocument('{ broken')).toThrow();
});

test('destroying an entity removes its gameplay subtree and leaves unrelated models intact', () => {
  const { models } = library();
  const world = new World(models);
  world.createEntity({ id: 'group' });
  world.createEntity({ id: 'child', parent: 'group', model: { asset: 'hero' } });
  world.createEntity({ id: 'grandchild', parent: 'child' });
  const other = world.createEntity({ id: 'other', model: { asset: 'hero' } });
  const revision = world.structureRevision;
  world.destroyEntity('group');
  expect(world.entities).toEqual([other]);
  expect(world.structureRevision).toBeGreaterThan(revision);
  expect(world.models.get('hero')).toBe(other.model!.asset);
  expect(() => world.createEntity({ id: 'other' })).toThrow();
  expect(() => world.models.register('hero', animatedAsset(), 'hero.glb')).toThrow();
});
