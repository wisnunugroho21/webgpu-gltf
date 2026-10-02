import type { ComponentRegistry } from './components/registry';
import { identifier } from './serialization/json';
export { identifier, copyJson, type JsonValue } from './serialization/json';
import { validateParents } from './world/validation';
import { expandAuthoringScene } from './serialization/prefabs';
import {
  record,
  fields,
  entityDefinition,
  type EntityDefinition,
} from './serialization/entity-definition';
export {
  entityDefinition,
  transformOwner,
  type EntityDefinition,
  type EntityTransformOwner,
} from './serialization/entity-definition';
export { transformData, type TransformData } from '../scene/transform';
export interface SceneDocument {
  version: 1;
  assets: Record<string, string>;
  entities: EntityDefinition[];
}

/** Validate before loading assets or publishing a world. Parents may appear later in
 * the file, but missing parents, duplicate IDs and cycles are rejected atomically. */
export function parseSceneDocument(value: unknown, components?: ComponentRegistry): SceneDocument {
  const source = record(expandAuthoringScene(value), 'Scene');
  fields(source, ['version', 'assets', 'entities'], 'scene');
  if (source.version !== 1) throw new Error('Unsupported engine scene version.');
  const assets: Record<string, string> = Object.create(null);
  for (const [id, uri] of Object.entries(record(source.assets, 'Assets'))) {
    identifier(id);
    assets[id] = identifier(uri);
  }
  if (!Array.isArray(source.entities)) throw new Error('Scene entities must be an array.');
  const entities = source.entities.map((value, index) => {
    const entity = entityDefinition(value);
    if (components)
      entity.components = components.validateAll(
        entity.components ?? {},
        `entities[${index}] (${JSON.stringify(entity.id)})`,
      );
    return entity;
  });
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  if (byId.size !== entities.length) throw new Error('Duplicate entity ID.');
  for (const [index, entity] of entities.entries()) {
    if (entity.model && !Object.hasOwn(assets, entity.model.asset))
      throw new Error(
        `Missing model asset ${entity.model.asset} at entities[${index}].model.asset (entity ${entity.id}).`,
      );
  }
  validateParents(new Map(entities.map((entity) => [entity.id, entity.parent])));
  return { version: 1, assets, entities };
}
