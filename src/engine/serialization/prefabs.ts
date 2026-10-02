import { copyJson, identifier } from './json';
import { entityDefinition, type EntityDefinition } from './entity-definition';
import { validateParents } from '../world/validation';

export interface PrefabDefinition {
  entities: EntityDefinition[];
}
export interface PrefabInstance {
  id: string;
  prefab: string;
  parent?: string;
  transform?: EntityDefinition['transform'];
}
export interface AuthoringScene {
  version: 2;
  assets: Record<string, string>;
  entities: EntityDefinition[];
  prefabs: Record<string, PrefabDefinition>;
  instances: PrefabInstance[];
}

/** Version 1 flat scenes migrate without changing IDs or asset references.
 * Prefabs are local templates, expanded once at load; there is no live inheritance. */
export function migrateScene(value: unknown): AuthoringScene {
  const input = typeof value === 'string' ? JSON.parse(value) : value;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Scene must be an object.');
  const source = input as AuthoringScene;
  if (![1, 2].includes(source.version)) throw new Error('Unsupported engine scene version.');
  const allowed =
    source.version === 2
      ? ['version', 'assets', 'entities', 'prefabs', 'instances']
      : ['version', 'assets', 'entities'];
  for (const key of Object.keys(source))
    if (!allowed.includes(key)) throw new Error(`Unknown scene field ${key}.`);
  const clone = copyJson(input) as unknown as AuthoringScene;
  return source.version === 2 ? clone : { ...clone, version: 2, prefabs: {}, instances: [] };
}

/** A wrapper owns placement; template roots retain their authored local transforms.
 * Prefixing every local ID makes multiple instances independent gameplay identities. */
export function expandPrefab(
  source: PrefabDefinition,
  instance: PrefabInstance,
): EntityDefinition[] {
  identifier(instance.id);
  identifier(instance.prefab);
  for (const key of Object.keys(instance))
    if (!['id', 'prefab', 'parent', 'transform'].includes(key))
      throw new Error(`Unknown prefab instance field ${key}.`);
  if (
    !source ||
    Object.keys(source).some((key) => key !== 'entities') ||
    !Array.isArray(source.entities)
  )
    throw new Error('Prefab must contain entities.');
  const entities = source.entities.map(entityDefinition);
  const parents = new Map(entities.map((entity) => [entity.id, entity.parent]));
  if (parents.size !== entities.length) throw new Error('Duplicate prefab entity ID.');
  validateParents(parents);
  const prefix = (id: string) => `${instance.id}/${id}`;
  return [
    entityDefinition({ id: instance.id, parent: instance.parent, transform: instance.transform }),
    ...entities.map((entity) => ({
      ...entity,
      id: prefix(entity.id),
      parent: entity.parent === undefined ? instance.id : prefix(entity.parent),
    })),
  ];
}

export function expandAuthoringScene(value: unknown): {
  version: 1;
  assets: Record<string, string>;
  entities: EntityDefinition[];
} {
  const scene = migrateScene(value);
  if (
    !scene.prefabs ||
    typeof scene.prefabs !== 'object' ||
    Array.isArray(scene.prefabs) ||
    !Array.isArray(scene.instances) ||
    !Array.isArray(scene.entities)
  )
    throw new Error('Invalid authoring prefabs/instances/entities.');
  // Validate unused templates too, so errors do not hide until a later spawn.
  for (const [id, prefab] of Object.entries(scene.prefabs))
    expandPrefab(prefab, { id: identifier(id), prefab: id });
  const expanded = scene.instances.flatMap((instance) => {
    if (!instance || !Object.hasOwn(scene.prefabs, instance.prefab))
      throw new Error(`Missing prefab ${instance?.prefab}.`);
    return expandPrefab(scene.prefabs[instance.prefab], instance);
  });
  return { version: 1, assets: scene.assets, entities: [...scene.entities, ...expanded] };
}
