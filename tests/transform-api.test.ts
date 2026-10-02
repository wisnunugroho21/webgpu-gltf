import { expect, test } from 'vitest';
import { World, ModelLibrary } from '../src/engine';
import { Pose } from '../src/scene/pose';
import { animatedAsset } from './fixtures/animated';

test('local transform overrides propagate descendants, preserve animation and advance only effective revisions', () => {
  const pose = new Pose(animatedAsset());
  pose.evaluate(0, 1);
  const before = pose.nodes.map((node) => node.worldRevision);
  const version = pose.revision;
  const input = [3, 0, 0];
  expect(pose.setNodeTransform(1, { translation: input })).toBe(true);
  input[0] = 999;
  expect(pose.getNodeTransform(1).translation).toEqual([3, 0, 0]);
  expect(pose.capture()[1].translation).toEqual([0, 0, 0]);
  expect(pose.nodes[2].worldRevision).toBe(before[2] + 1);
  expect(pose.nodes[0].worldRevision).toBe(before[0]);
  expect(pose.nodes[3].worldRevision).toBe(before[3]);
  expect(pose.revision).toBe(version + 1);
  expect(pose.setNodeTransform(1, { translation: [3, 0, 0] })).toBe(false);
  expect(pose.revision).toBe(version + 1);
  const copy = pose.getNodeTransform(1);
  copy.translation[0] = 999;
  expect(pose.getNodeTransform(1).translation[0]).toBe(3);
  pose.evaluate(0, 2);
  expect(pose.getNodeTransform(1).translation[0]).toBe(3);
  expect(pose.setNodeTransform(3, { scale: [-2, 2, 2] })).toBe(true);
  pose.evaluate(2, 1);
  expect(pose.getNodeTransform(3).translation[0]).toBe(2.5);
  expect(pose.getNodeTransform(3).scale).toEqual([-2, 2, 2]);
  expect(pose.setNodeTransform(3, { translation: [7, 0, 0] })).toBe(true);
  pose.evaluate(2, 2);
  expect(pose.getNodeTransform(3).translation[0]).toBe(7);
  expect(pose.clearNodeTransform(3)).toBe(true);
  expect(pose.getNodeTransform(3).translation[0]).toBe(3);
  expect(pose.getNodeTransform(3).scale).toEqual([1, 1, 1]);
  expect(pose.clearNodeTransform(3)).toBe(false);
});

test('invalid transform edits are atomic and copied setters normalize rotations', () => {
  const asset = animatedAsset();
  asset.gltf.nodes!.push({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  const pose = new Pose(asset);
  const version = pose.revision,
    before = pose.getNodeTransform(3);
  for (const patch of [
    { translation: [1, 2] },
    { translation: [Infinity, 0, 0] },
    { scale: [0, 1, 1] },
    { rotation: [0, 0, 0, 0] },
    { unknown: 1 },
  ])
    expect(() => pose.setNodeTransform(3, patch as any)).toThrow();
  expect(() => pose.setNodeTransform(999, {})).toThrow('Unknown');
  expect(() => pose.setNodeTransform(4, {})).toThrow('TRS');
  expect(pose.getNodeTransform(3)).toEqual(before);
  expect(pose.revision).toBe(version);
  expect(pose.setNodeTransform(3, {})).toBe(false);
  expect(pose.setNodeTransform(3, { rotation: [0, 0, 0, 2] })).toBe(false);
  expect(pose.getNodeTransform(3).rotation).toEqual([0, 0, 0, 1]);
});

test('world revisions retain gameplay edits across repeated simulation and held animation', () => {
  const models = new ModelLibrary(),
    asset = animatedAsset();
  models.register('hero', asset, 'hero.glb');
  const world = new World(models);
  const a = world.createEntity({ id: 'a', model: { asset: 'hero' } });
  const b = world.createEntity({ id: 'b', model: { asset: 'hero' } });
  for (const model of world.modelInstances) {
    model.animation.select(-1);
    model.animation.setPlaying(false);
  }
  world.update(0);
  const version = world.poseRevision,
    other = b.model!.pose.revision;
  a.model!.setNodeTransform(1, { translation: [8, 0, 0] });
  world.update(0);
  expect(world.poseRevision).toBe(version + 1);
  expect(b.model!.pose.revision).toBe(other);
  world.update(0);
  expect(world.poseRevision).toBe(version + 1);
  expect(a.model!.pose.nodes[2].world[12]).toBe(8);
  expect(asset.gltf.nodes![1].translation).toBeUndefined();
  a.model!.clearNodeTransform(1);
  world.update(0);
  expect(world.poseRevision).toBe(version + 2);
});

test('entity root authority has explicit handoff and survives animation, overrides and scene saving', () => {
  const models = new ModelLibrary();
  models.register('hero', animatedAsset(), 'hero.glb');
  const world = new World(models);
  const entity = world.createEntity({ id: 'player', model: { asset: 'hero' } });
  expect(entity.transformOwner).toBe('gameplay');
  entity.setTransform({ translation: [4, 0, 0] });
  expect(() => entity.setTransform({ translation: [999, 0, 0] }, 'physics')).toThrow(
    'owned by gameplay',
  );
  entity.setTransformOwner('physics');
  expect(entity.transform.translation[0]).toBe(4);
  expect(() => entity.setTransform({ translation: [999, 0, 0] })).toThrow('owned by physics');
  entity.setTransform({ translation: [7, 0, 0] }, 'physics');
  const model = entity.model!;
  model.animation.setPlaying(false);
  model.animation.select(2);
  model.animation.seek(1);
  world.update(0);
  expect(model.getNodeTransform(3).translation[0]).toBe(2.5);
  model.setNodeOverride(3, { translation: [5, 0, 0], scale: [2, 2, 2] });
  const copy = model.getNodeOverride(3);
  copy.translation![0] = 999;
  expect(model.getNodeOverride(3).translation![0]).toBe(5);
  expect(() => model.clearNodeOverride(3, ['invalid'] as any)).toThrow();
  model.clearNodeOverride(3, ['translation']);
  expect(model.getNodeTransform(3).translation[0]).toBe(2.5);
  expect(model.getNodeOverride(3)).toEqual({ scale: [2, 2, 2] });
  model.animation.crossFadeTo(-1, 1);
  model.animation.setPlaying(true);
  world.update(0);
  world.update(1000);
  expect(model.getNodeTransform(3).translation[0]).toBe(2);
  expect(model.getNodeTransform(3).scale).toEqual([2, 2, 2]);
  expect(entity.transform.translation[0]).toBe(7);
  expect(model.pose.nodes[3].world[12]).toBe(9);
  model.clearNodeOverride(3);
  expect(model.getNodeOverride(3)).toEqual({});
  const saved = world.toDocument();
  expect(saved.entities[0].transformOwner).toBe('physics');
  expect(World.fromDocument(saved, models).getEntity('player').transformOwner).toBe('physics');
  expect(() => world.createEntity({ id: 'bad', transformOwner: 'animation' } as any)).toThrow();
  expect(() => entity.setTransformOwner('animation' as any)).toThrow();
  expect(entity.transformOwner).toBe('physics');
  entity.setTransformOwner('gameplay');
  entity.setTransform({ translation: [8, 0, 0] });
  expect(entity.transform.translation[0]).toBe(8);
});
