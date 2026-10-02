import { expect, test } from 'vitest';
import { World, ModelLibrary } from '../src/engine';
import { animatedAsset } from './fixtures/animated';

test('deep hierarchy evaluation, scene validation and destruction are iterative', () => {
  const count = 25_000;
  const world = new World();
  for (let i = 0; i < count; i++)
    world.createEntity({
      id: String(i),
      ...(i ? { parent: String(i - 1) } : {}),
      transform: { translation: [1, 0, 0] },
    });
  world.updateTransforms();
  expect(world.getEntity(String(count - 1)).worldMatrix[12]).toBe(count);
  expect(world.hierarchyStats).toMatchObject({ recomputedWorlds: count, traversalRebuilds: 1 });
  world.updateTransforms();
  expect(world.hierarchyStats).toMatchObject({
    visitedEntities: 0,
    recomputedWorlds: 0,
    traversalRebuilds: 0,
  });
  const document = world.toDocument();
  document.entities.reverse(); // Parents may occur after their children in scene JSON.
  const restored = World.fromDocument(document, new ModelLibrary());
  expect(restored.getEntity(String(count - 1)).worldMatrix[12]).toBe(count);
  restored.destroyEntity('0');
  expect(restored.entities).toEqual([]);
});

test('local changes evaluate only their subtree, overlapping edits run once and held worlds do nothing', () => {
  const world = new World();
  const root = world.createEntity({ id: 'root' });
  const left = world.createEntity({ id: 'left', parent: 'root' });
  const leaf = world.createEntity({ id: 'leaf', parent: 'left' });
  const right = world.createEntity({ id: 'right', parent: 'root' });
  world.updateTransforms();
  const rightRevision = right.worldRevision;
  left.setTransform({ translation: [2, 0, 0] });
  leaf.setTransform({ translation: [3, 0, 0] });
  world.updateTransforms();
  expect(world.hierarchyStats).toMatchObject({
    visitedEntities: 2,
    recomputedWorlds: 2,
    changedWorlds: 2,
    traversalRebuilds: 0,
  });
  expect(leaf.worldMatrix[12]).toBe(5);
  expect(right.worldRevision).toBe(rightRevision);
  root.setTransform({ translation: [1, 0, 0] });
  leaf.setTransform({ translation: [4, 0, 0] });
  world.updateTransforms();
  expect(world.hierarchyStats.recomputedWorlds).toBe(4);
  expect(leaf.worldMatrix[12]).toBe(7);
  expect(leaf.parentWorldRevision).toBe(left.worldRevision);
  world.updateTransforms();
  expect(world.hierarchyStats.visitedEntities).toBe(0);
});

test('equivalent local matrices stop propagation without losing independently dirty descendants', () => {
  const world = new World();
  const root = world.createEntity({ id: 'root' });
  world.createEntity({ id: 'child', parent: 'root' });
  const leaf = world.createEntity({ id: 'leaf', parent: 'child' });
  world.updateTransforms();
  const revision = root.worldRevision;
  root.setTransform({ rotation: [0, 0, 0, -1] }); // Equivalent quaternion sign.
  leaf.setTransform({ translation: [8, 0, 0] });
  world.updateTransforms();
  expect(root.worldRevision).toBe(revision);
  expect(leaf.worldMatrix[12]).toBe(8);
  expect(world.hierarchyStats).toMatchObject({
    visitedEntities: 2,
    recomputedWorlds: 2,
    changedWorlds: 1,
  });
  const local = root.localRevision;
  root.setTransform(root.transform);
  root.setTransformOwner('physics');
  expect(root.localRevision).toBe(local);
  expect(() => root.setTransform({ translation: [4, 0, 0] })).toThrow('owned by physics');
  world.updateTransforms();
  expect(world.hierarchyStats.visitedEntities).toBe(0);
});

test('reparenting invalidates topology while unchanged effective worlds retain revisions', () => {
  const world = new World();
  world.createEntity({ id: 'a' });
  world.createEntity({ id: 'b' });
  const child = world.createEntity({ id: 'child', parent: 'a' });
  world.createEntity({ id: 'leaf', parent: 'child' });
  world.updateTransforms();
  const version = child.worldRevision,
    membership = world.structureRevision;
  world.setParent('child', 'b');
  world.updateTransforms();
  expect(world.hierarchyStats).toMatchObject({
    visitedEntities: 1,
    recomputedWorlds: 1,
    changedWorlds: 0,
    traversalRebuilds: 1,
  });
  expect(child.worldRevision).toBe(version);
  expect(world.structureRevision).toBe(membership); // No GPU membership rebuild needed.
  const topology = world.hierarchyRevision;
  world.setParent('child', 'b');
  expect(world.hierarchyRevision).toBe(topology);
  world.getEntity('b').setTransform({ translation: [6, 0, 0] });
  world.updateTransforms();
  expect(world.getEntity('leaf').worldMatrix[12]).toBe(6);
});

test('atomic batches validate their final graph, rebuild once and retain a usable graph after failure', () => {
  const world = new World();
  world.applyChanges([
    { type: 'create', entity: { id: 'child', parent: 'parent' } },
    { type: 'create', entity: { id: 'parent', transform: { translation: [3, 0, 0] } } },
    { type: 'create', entity: { id: 'other', transform: { translation: [7, 0, 0] } } },
  ]);
  world.updateTransforms();
  expect(world.getEntity('child').worldMatrix[12]).toBe(3);
  const original = JSON.stringify(world.toDocument()),
    membership = world.structureRevision,
    topology = world.hierarchyRevision;
  for (const changes of [
    [{ type: 'reparent' as const, id: 'parent', parent: 'child' }],
    [{ type: 'create' as const, entity: { id: 'new', model: { asset: 'missing' } } }],
    [
      { type: 'destroy' as const, id: 'child' },
      { type: 'reparent' as const, id: 'parent', parent: 'missing' },
    ],
    [
      { type: 'create' as const, entity: { id: 'new' } },
      { type: 'create' as const, entity: { id: 'parent' } },
    ],
  ]) {
    expect(() => world.applyChanges(changes)).toThrow();
    expect(JSON.stringify(world.toDocument())).toBe(original);
    expect(world.structureRevision).toBe(membership);
    expect(world.hierarchyRevision).toBe(topology);
    world.updateTransforms();
    expect(world.hierarchyStats.visitedEntities).toBe(0);
  }
  // Temporary cycles are safe in staging if the final graph is valid. A net
  // no-op preserves traversal, identities and revisions rather than publishing it.
  expect(
    world.applyChanges([
      { type: 'reparent', id: 'parent', parent: 'child' },
      { type: 'reparent', id: 'parent' },
      { type: 'create', entity: { id: 'temporary' } },
      { type: 'destroy', id: 'temporary' },
    ]),
  ).toEqual([]);
  expect(world.structureRevision).toBe(membership);
  expect(world.hierarchyRevision).toBe(topology);
  world.updateTransforms();
  expect(world.hierarchyStats.traversalRebuilds).toBe(0);
  expect(() => world.setParent('parent', 'child')).toThrow('Cycle');
  expect(() => world.setParent('child', 'missing')).toThrow();
  world.applyChanges([
    { type: 'reparent', id: 'child', parent: 'other' },
    { type: 'destroy', id: 'parent' },
  ]);
  world.updateTransforms();
  expect(world.getEntity('child').worldMatrix[12]).toBe(7);
  expect(world.hierarchyStats.traversalRebuilds).toBe(1);
});

test('removed entity references cannot dirty a reused ID and getters remain copies', () => {
  const world = new World();
  const stale = world.createEntity({ id: 'entity' });
  world.updateTransforms();
  world.destroyEntity('entity');
  const current = world.createEntity({ id: 'entity' });
  world.updateTransforms();
  stale.setTransform({ translation: [99, 0, 0] });
  const copy = current.worldMatrix;
  copy[12] = 50;
  world.updateTransforms();
  expect(world.hierarchyStats.visitedEntities).toBe(0);
  expect(current.worldMatrix[12]).toBe(0);
});

test('numeric failure keeps last usable matrices and retries all unfinished branches', () => {
  const world = new World();
  const root = world.createEntity({ id: 'root' });
  const bad = world.createEntity({ id: 'bad', parent: 'root', transform: { scale: [2, 1, 1] } });
  const other = world.createEntity({ id: 'other', parent: 'root' });
  world.updateTransforms();
  const old = [...bad.worldMatrix];
  root.setTransform({ scale: [2e38, 1, 1] });
  expect(() => world.updateTransforms()).toThrow('float32 range');
  expect([...bad.worldMatrix]).toEqual(old);
  bad.setTransform({ scale: [1, 1, 1] });
  world.updateTransforms();
  expect(bad.worldMatrix[0]).toBeCloseTo(root.worldMatrix[0], -30);
  expect(other.worldMatrix[0]).toBe(root.worldMatrix[0]);
  world.updateTransforms();
  expect(world.hierarchyStats.recomputedWorlds).toBe(0);
});

test('parent edits synchronize only affected model roots while independent animation revisions survive', () => {
  const models = new ModelLibrary();
  models.register('hero', animatedAsset(), 'hero.glb');
  const world = new World(models);
  const root = world.createEntity({ id: 'root' });
  const hero = world.createEntity({ id: 'hero', parent: 'root', model: { asset: 'hero' } });
  const other = world.createEntity({ id: 'other', model: { asset: 'hero' } });
  world.update(0);
  const revision = other.model!.pose.revision;
  root.setTransform({ translation: [10, 0, 0], scale: [-1, 1, 1] });
  world.update(0);
  expect(world.hierarchyStats).toMatchObject({ recomputedWorlds: 2, syncedModelRoots: 1 });
  expect(other.model!.pose.revision).toBe(revision);
  expect(hero.model!.pose.rootMirrored).toBe(true);
  const aggregate = world.poseRevision;
  world.update(1000);
  expect(world.hierarchyStats.recomputedWorlds).toBe(0);
  expect(world.poseRevision).toBeGreaterThan(aggregate);
});
