import { expect, test } from 'vitest';
import { World, WorldEditor, AssetRegistry, captureSaveState } from '../src/engine';
import { gameComponents } from '../src/game/components';
import { createLevelWorld, installLevelCollisions } from '../src/game/level';
import type { PhysicsAdapter } from '../src/engine/physics/contracts';
import { animatedAsset } from './fixtures/animated';

function scene() {
  const assets = new AssetRegistry();
  assets.register('hero', animatedAsset(), 'fixture:hero');
  const world = new World(assets, gameComponents());
  world.applyChanges([
    { type: 'create', entity: { id: 'root' } },
    {
      type: 'create',
      entity: {
        id: 'actor',
        parent: 'root',
        model: { asset: 'hero' },
        components: { 'game.actor': { version: 1, role: 'companion' } },
      },
    },
  ]);
  world.update(0);
  return { world, editor: new WorldEditor(world), actor: world.getEntity('actor') };
}
const ordered = (world: World) => {
  const snapshot = captureSaveState(world);
  snapshot.scene.entities.sort((a, b) => a.id.localeCompare(b.id));
  return snapshot;
};

test('editor transform commands use supported revisions and preserve model identity through undo/redo', () => {
  const { world, editor, actor } = scene();
  const model = actor.model;
  const revision = actor.localRevision,
    rootRevision = model!.pose.revision;
  const patch = { translation: [3, 2, 1] };
  expect(editor.execute({ type: 'set-transform', id: 'actor', patch })).toEqual({
    membershipChanged: false,
  });
  patch.translation[0] = 99;
  world.updateTransforms();
  expect(actor.localRevision).toBeGreaterThan(revision);
  expect(model!.pose.revision).toBeGreaterThan(rootRevision);
  expect(actor.worldMatrix[12]).toBe(3);
  editor.undo();
  world.updateTransforms();
  expect(actor.transform.translation).toEqual([0, 0, 0]);
  editor.redo();
  world.updateTransforms();
  expect(actor.transform.translation).toEqual([3, 2, 1]);
  expect(actor.model).toBe(model);
  expect(editor.exportScene().assets).toEqual({ hero: 'fixture:hero' });
});

test('component commands preserve versioned and unknown JSON without aliases; failed writes leave history usable', () => {
  const { actor, editor } = scene();
  editor.execute({
    type: 'set-component',
    id: 'actor',
    key: 'game.actor',
    value: { version: 1, role: 'player' },
  });
  expect(() =>
    editor.execute({
      type: 'set-component',
      id: 'actor',
      key: 'game.actor',
      value: { version: 2, role: 'player' },
    }),
  ).toThrow('version');
  editor.undo();
  expect(actor.getComponent('game.actor')).toEqual({ version: 1, role: 'companion' });
  editor.redo();
  const value = { author: { tag: 'original' } };
  editor.execute({ type: 'set-component', id: 'actor', key: 'custom', value });
  value.author.tag = 'changed';
  editor.undo();
  expect(actor.getComponent('custom')).toBeUndefined();
  editor.redo();
  expect(actor.getComponent('custom')).toEqual({ author: { tag: 'original' } });
  editor.execute({ type: 'remove-component', id: 'actor', key: 'custom' });
  editor.undo();
  expect(actor.getComponent('custom')).toEqual({ author: { tag: 'original' } });
});

test('membership inversion handles reparenting, subtree deletion, playback/overrides and survivor identity', () => {
  const { world, editor, actor } = scene();
  actor.model!.animation.select(1);
  actor.model!.animation.setPlaying(false);
  actor.model!.animation.seek(0.5);
  actor.model!.setNodeOverride(2, { translation: [0, 2, 0] });
  world.createEntity({ id: 'deleted', parent: 'root', model: { asset: 'hero' } });
  const deleted = world.getEntity('deleted');
  deleted.model!.animation.select(2);
  deleted.model!.setNodeOverride(3, { scale: [2, 2, 2] });
  editor.clearHistory();
  const before = ordered(world);
  editor.execute({
    type: 'membership',
    changes: [
      { type: 'create', entity: { id: 'new' } },
      { type: 'reparent', id: 'actor', parent: 'new' },
      { type: 'destroy', id: 'root' },
    ],
  });
  const after = ordered(world);
  expect(world.getEntity('actor')).toBe(actor);
  expect(editor.undo().membershipChanged).toBe(true);
  expect(ordered(world)).toEqual(before);
  expect(world.getEntity('actor')).toBe(actor);
  expect(world.getEntity('deleted')).not.toBe(deleted);
  editor.redo();
  expect(ordered(world)).toEqual(after);
  editor.undo();
  expect(ordered(world)).toEqual(before);
});

test('inverse detaches surviving children even when a new parent reuses the same ID', () => {
  const { world, editor, actor } = scene();
  const root = world.getEntity('root');
  editor.execute({
    type: 'membership',
    changes: [
      { type: 'reparent', id: 'actor', parent: undefined },
      { type: 'destroy', id: 'root' },
      { type: 'create', entity: { id: 'root', transform: { translation: [1, 0, 0] } } },
      { type: 'reparent', id: 'actor', parent: 'root' },
    ],
  });
  editor.undo();
  expect(world.getEntity('actor')).toBe(actor);
  expect(world.getParent('actor')!.id).toBe('root');
  expect(world.getEntity('root').transform.translation).toEqual([0, 0, 0]);
  expect(world.getEntity('root')).not.toBe(root);
});

test('failed membership validation and initialization do not publish edits or consume history', () => {
  const { world, editor, actor } = scene();
  editor.execute({ type: 'set-transform', id: 'actor', patch: { translation: [1, 0, 0] } });
  const structure = world.structureRevision;
  expect(() =>
    editor.execute({
      type: 'membership',
      changes: [
        { type: 'destroy', id: 'root' },
        { type: 'create', entity: { id: 'bad', parent: 'missing' } },
      ],
    }),
  ).toThrow();
  expect(world.getEntity('actor')).toBe(actor);
  expect(world.structureRevision).toBe(structure);
  expect(() =>
    world.applyChanges(
      [
        { type: 'destroy', id: 'root' },
        { type: 'create', entity: { id: 'bad' } },
      ],
      () => {
        throw new Error('Initializer failed');
      },
    ),
  ).toThrow('Initializer failed');
  expect(world.getEntity('actor')).toBe(actor);
  editor.undo();
  expect(actor.transform.translation).toEqual([0, 0, 0]);
});

test('physics ownership, outside edits and same-ID replacement reject unsafe history replay', () => {
  const { world, actor, editor } = scene();
  actor.setTransformOwner('physics');
  editor.clearHistory();
  expect(() =>
    editor.execute({ type: 'set-transform', id: 'actor', patch: { translation: [2, 0, 0] } }),
  ).toThrow('owned by physics');
  expect(editor.canUndo).toBe(false);
  actor.setTransformOwner('gameplay');
  editor.clearHistory();
  editor.execute({ type: 'set-transform', id: 'actor', patch: { translation: [2, 0, 0] } });
  actor.setComponent('outside', true);
  expect(() => editor.undo()).toThrow('outside the editor');
  expect(actor.transform.translation[0]).toBe(2);
  editor.clearHistory();
  editor.execute({ type: 'set-component', id: 'actor', key: 'outside', value: false });
  const definition = actor.definition('root');
  world.applyChanges([
    { type: 'destroy', id: 'actor' },
    { type: 'create', entity: definition },
  ]);
  expect(() => editor.undo()).toThrow('outside the editor');
});

test('selection is detached, history is bounded, noops retain redo and export round-trips versioned assets/components', () => {
  const { world, actor } = scene();
  const editor = new WorldEditor(world, 2);
  editor.select(['actor', 'actor']);
  expect(() => editor.select(['missing'])).toThrow();
  const selection = editor.selection as string[];
  selection.length = 0;
  expect(editor.selection).toEqual(['actor']);
  for (const x of [1, 2, 3])
    editor.execute({ type: 'set-transform', id: 'actor', patch: { translation: [x, 0, 0] } });
  editor.undo();
  editor.undo();
  expect(editor.canUndo).toBe(false);
  expect(actor.transform.translation[0]).toBe(1);
  editor.execute({ type: 'set-transform', id: 'actor', patch: { translation: [1, 0, 0] } });
  expect(editor.canRedo).toBe(true);
  editor.redo();
  const loaded = World.fromDocument(editor.exportScene(), world.models, world.components);
  expect(loaded.getEntity('actor').getComponent('game.actor')).toEqual({
    version: 1,
    role: 'companion',
  });
  editor.execute({ type: 'membership', changes: [{ type: 'destroy', id: 'actor' }] });
  expect(editor.selection).toEqual([]);
  expect(() => new WorldEditor(world, 0)).toThrow('history limit');
});

test('edited collision content round-trips into a fresh backend; legacy boxes remain supported and invalid shapes fail before allocation', () => {
  const world = createLevelWorld();
  const editor = new WorldEditor(world);
  editor.execute({ type: 'set-transform', id: 'level-5', patch: { translation: [4, 0.5, -3] } });
  const loaded = World.fromDocument(editor.exportScene(), world.models, world.components);
  const boxes: { center: readonly number[]; half: readonly number[] }[] = [];
  const backend: PhysicsAdapter = {
    addBox: (center, half) => {
      boxes.push({ center, half });
    },
    createCharacter() {
      throw new Error('Not used');
    },
    step() {},
    destroy() {},
  };
  installLevelCollisions(loaded, backend);
  expect(boxes).toHaveLength(8);
  expect(boxes[5]).toEqual({ center: [4, 0.5, -3], half: [1.5, 0.5, 0.5] });
  loaded.getEntity('level-0').removeComponent('game.colliderBox');
  boxes.length = 0;
  installLevelCollisions(loaded, backend);
  expect(boxes).toHaveLength(7);
  boxes.length = 0;
  installLevelCollisions(loaded, backend, true);
  expect(boxes).toHaveLength(8);
  loaded.getEntity('level-7').setTransform({ rotation: [0, Math.sin(0.2), 0, Math.cos(0.2)] });
  boxes.length = 0;
  expect(() => installLevelCollisions(loaded, backend)).toThrow('axis-aligned');
  expect(boxes).toEqual([]);
  expect(() =>
    world
      .getEntity('level-0')
      .setComponent('game.colliderBox', { version: 1, halfExtents: [0, 1, 1] }),
  ).toThrow('halfExtents');
  const unknown = new World();
  unknown.createEntity({
    id: 'future',
    components: { 'game.colliderBox': { version: 2, halfExtents: [1, 1, 1] } },
  });
  expect(() => installLevelCollisions(unknown, backend)).toThrow('version 1');
  world.models.destroy();
});

test('structural history supports prototype-like entity IDs without fabricating model restoration state', () => {
  const world = new World();
  world.createEntity({ id: 'toString' });
  world.createEntity({ id: '__proto__', parent: 'toString' });
  const editor = new WorldEditor(world);
  editor.execute({ type: 'membership', changes: [{ type: 'destroy', id: 'toString' }] });
  editor.undo();
  expect(world.getParent('__proto__')!.id).toBe('toString');
  expect(world.getEntity('toString').model).toBeUndefined();
  editor.redo();
  expect(world.entities).toEqual([]);
});
