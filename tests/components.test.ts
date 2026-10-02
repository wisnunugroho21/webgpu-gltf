import { expect, test } from 'vitest';
import { ComponentRegistry, World, ModelLibrary, parseSceneDocument } from '../src/engine';
interface Health {
  current: number;
  max: number;
}
function registry(unknown: 'preserve' | 'reject' = 'preserve') {
  const components = new ComponentRegistry(unknown);
  const health = components.register<Health>('health', {
    parse(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof value.current !== 'number' ||
        value.current < 0
      )
        throw new Error('current must be a nonnegative number');
      const max = typeof value.max === 'number' ? value.max : 100;
      if (max < value.current) throw new Error('current exceeds max');
      return { current: value.current, max };
    },
  });
  return { components, health };
}

test('typed schemas validate and copy both typed and string access without publishing failed writes', () => {
  const { components, health } = registry();
  const world = new World(undefined, components);
  const entity = world.createEntity({
    id: 'player',
    components: { health: { current: 80 }, custom: { tag: 'quest' } },
  });
  const initial: Health | undefined = entity.getComponent(health);
  expect(initial).toEqual({ current: 80, max: 100 });
  initial!.current = 0;
  expect(entity.getComponent(health)!.current).toBe(80);
  entity.setComponent(health, { current: 70, max: 100 });
  expect(() => entity.setComponent('health', { current: -1 })).toThrow(
    'entities["player"].components["health"]',
  );
  expect(entity.getComponent(health)!.current).toBe(70);
  expect(entity.getComponent('custom')).toEqual({ tag: 'quest' });
  entity.removeComponent(health);
  expect(entity.getComponent(health)).toBeUndefined();
  expect(() => entity.requireComponent(health)).toThrow('entities["player"].components["health"]');
});

test('component validation precedes scene publication and failed structural batches retain live identities', () => {
  const { components, health } = registry('reject');
  const world = new World(undefined, components);
  const entity = world.createEntity({ id: 'player', components: { health: { current: 5 } } });
  expect(() =>
    world.applyChanges([
      { type: 'destroy', id: 'player' },
      { type: 'create', entity: { id: 'bad', components: { health: { current: -2 } } } },
    ]),
  ).toThrow('components["health"]');
  expect(world.getEntity('player')).toBe(entity);
  const source = {
    version: 1,
    assets: {},
    entities: [{ id: 'npc', components: { health: { current: -2 } } }],
  };
  expect(() => parseSceneDocument(source, components)).toThrow(
    'entities[0] ("npc").components["health"]',
  );
  expect(() => world.createEntity({ id: 'unknown', components: { other: 1 } })).toThrow(
    'Unknown component other',
  );
  const other = registry();
  expect(() => entity.getComponent(other.health)).toThrow('another registry');
  expect(entity.getComponent(health)!.current).toBe(5);
});

test('unknown JSON round trips and registering a schema later cannot permit an invalid typed read', () => {
  const components = new ComponentRegistry();
  const world = new World(undefined, components);
  const entity = world.createEntity({
    id: 'a',
    components: { future: { enabled: true }, health: { current: -1 } },
  });
  const document = world.toDocument();
  const loaded = World.fromDocument(document, new ModelLibrary(), components);
  expect(loaded.getEntity('a').getComponent('future')).toEqual({ enabled: true });
  const health = components.register<Health>('health', {
    parse() {
      throw new Error('invalid health');
    },
  });
  expect(() => entity.getComponent(health)).toThrow('invalid health');
  expect(() => world.toDocument()).toThrow('invalid health');
  expect(() => components.register('health', { parse: (value) => value })).toThrow(
    'already registered',
  );
});
