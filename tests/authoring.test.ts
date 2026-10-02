import { expect, test, vi } from 'vitest';
import {
  World,
  AssetRegistry,
  EngineRuntime,
  parseSceneDocument,
  migrateScene,
  captureSaveState,
  loadSaveState,
  inspectWorld,
} from '../src/engine';
import { animatedAsset } from './fixtures/animated';
import { characterAsset } from '../src/game/assets';
import { RapierPhysics } from '../src/engine/physics/rapier';

test('migrates flat scenes and expands independent prefab hierarchies before publication', () => {
  const old = { version: 1, assets: {}, entities: [{ id: 'parent' }] };
  expect(migrateScene(old)).toEqual({ ...old, version: 2, prefabs: {}, instances: [] });
  const scene = {
    ...migrateScene(old),
    prefabs: {
      actor: {
        entities: [
          { id: 'root', transform: { translation: [1, 0, 0] } },
          { id: 'child', parent: 'root', components: { hp: 100 } },
        ],
      },
    },
    instances: [
      { id: 'a', prefab: 'actor', parent: 'parent', transform: { translation: [2, 0, 0] } },
      { id: 'b', prefab: 'actor' },
    ],
  };
  const world = World.fromDocument(scene, new AssetRegistry());
  expect(world.getEntity('a/root').worldMatrix[12]).toBe(3);
  world.getEntity('a/child').setComponent('hp', 20);
  expect(world.getEntity('b/child').getComponent('hp')).toBe(100);
  expect(scene.prefabs.actor.entities[1].components?.hp).toBe(100);
  expect(world.toDocument().version).toBe(1);
  expect(parseSceneDocument(world.toDocument()).entities).toHaveLength(7);
  expect(() =>
    parseSceneDocument({ ...scene, instances: [{ id: 'a', prefab: 'missing' }] }),
  ).toThrow('Missing prefab');
  expect(() => parseSceneDocument({ ...scene, entities: [{ id: 'a/root' }] })).toThrow('Duplicate');
  expect(() =>
    parseSceneDocument({ ...scene, prefabs: { broken: { entities: [{ id: 'x', parent: 'x' }] } } }),
  ).toThrow();
  expect(() => migrateScene({ ...old, version: 3 })).toThrow('version');
});

test('save round-trip preserves interrupted blending, overlays, roots, overrides and fixed clocks', async () => {
  const assets = new AssetRegistry();
  assets.register('hero', characterAsset(), 'fixture:hero');
  const world = new World(assets);
  const entity = world.createEntity({
    id: 'hero',
    transformOwner: 'physics',
    model: { asset: 'hero' },
    components: { health: 75 },
  });
  entity.setTransform({ translation: [4, 2, 3] }, 'physics');
  const animation = entity.model!.animation;
  animation.setClock('external');
  animation.setRootMotion({ node: 0, mode: 'extract' });
  animation.select(1);
  animation.advance(0.4);
  animation.crossFadeTo(2, 0.8);
  animation.advance(0.2);
  animation.crossFadeTo(0, 0.5);
  animation.setOverlays([
    { clip: 3, time: 0.5, weight: 0.7, speed: 0, mask: [3, 4], additive: true },
  ]);
  entity.model!.setNodeOverride(0, { rotation: [0, 0.5, 0, Math.sqrt(0.75)] });
  const runtime = new EngineRuntime(world, {}, { stepMs: 10 });
  runtime.advance(0);
  runtime.advance(25);
  runtime.pause();
  world.update(25);
  const saved = captureSaveState(world, runtime, { quest: 'started', velocity: 2 });
  const result = await loadSaveState(JSON.stringify(saved), { assets });
  const restored = result.world.getEntity('hero');
  expect(restored.transform).toEqual(entity.transform);
  expect(restored.transformOwner).toBe('physics');
  expect(restored.model!.animation.checkpoint()).toEqual(animation.checkpoint());
  expect(restored.model!.pose.nodes.map((n) => n.rotation)).toEqual(
    entity.model!.pose.nodes.map((n) => n.rotation),
  );
  const newRuntime = new EngineRuntime(result.world, {}, { stepMs: 10 });
  newRuntime.restore(result.runtime!);
  expect(newRuntime.advance(9999).simulationTimeMs).toBe(20);
  animation.advance(0.2);
  restored.model!.animation.advance(0.2);
  expect(restored.model!.pose.nodes.map((n) => n.translation)).toEqual(
    entity.model!.pose.nodes.map((n) => n.translation),
  );
  expect(restored.model!.animation.consumeRootMotion()).toEqual(animation.consumeRootMotion());
  expect(restored.model!.animation.drainEvents()).toEqual(animation.drainEvents());
  const inspection = inspectWorld(result.world);
  inspection.entities[0].transform!.translation![0] = 999;
  expect(restored.transform.translation[0]).toBe(4);
  runtime.destroy();
  newRuntime.destroy();
  assets.destroy();
});

test('bad save data never edits an existing world; malformed runtime fails before loading', async () => {
  const resolve = vi.fn(async () => animatedAsset());
  const assets = new AssetRegistry({ resolve });
  const world = new World(assets);
  assets.register('hero', animatedAsset(), 'fixture:hero');
  world.createEntity({ id: 'a', model: { asset: 'hero' } });
  const saved = captureSaveState(world);
  saved.models.a.animation.layers = [{ clip: 999, time: 0, weight: 1 }];
  await expect(loadSaveState(saved, { assets })).rejects.toThrow('animation');
  expect(world.getEntity('a').model!.animation.state.clip).toBe(0);
  saved.runtime = { version: 1, stepMs: 10, accumulatorMs: 10, simulationTimeMs: 0, paused: false };
  await expect(loadSaveState(saved, { assets })).rejects.toThrow('runtime');
  expect(resolve).not.toHaveBeenCalled();
  assets.destroy();
});

test('Rapier saves vertical movement and resumes the same airborne trajectory', async () => {
  const physics = await RapierPhysics.create();
  physics.addBox([0, -0.25, 0], [10, 0.25, 10]);
  const a = physics.createCharacter([0, 0.02, 0]);
  physics.step(1 / 60);
  for (let i = 0; i < 5; i++) {
    a.move({ x: 0, z: 0, jump: false }, 1 / 60);
    physics.step(1 / 60);
  }
  a.move({ x: 0, z: 0, jump: true }, 1 / 60);
  physics.step(1 / 60);
  const checkpoint = a.checkpoint!();
  expect(checkpoint.verticalVelocity).toBeGreaterThan(0);
  // Separate backend avoids characters colliding with one another.
  const other = await RapierPhysics.create();
  other.addBox([0, -0.25, 0], [10, 0.25, 10]);
  const b = other.createCharacter(checkpoint.position);
  b.restore!(checkpoint);
  other.step(1 / 60);
  for (let i = 0; i < 10; i++) {
    a.move({ x: 0, z: 0, jump: false }, 1 / 60);
    physics.step(1 / 60);
    b.move({ x: 0, z: 0, jump: false }, 1 / 60);
    other.step(1 / 60);
  }
  expect(b.position[1]).toBeCloseTo(a.position[1], 5);
  physics.destroy();
  other.destroy();
});
