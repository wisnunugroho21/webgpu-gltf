import type { ComponentRegistry } from './components/registry';
import { identifier, copyJson, type JsonValue } from './serialization/json';
export { identifier, copyJson, type JsonValue } from './serialization/json';
import { validateParents } from './world/validation';
/** Engine scenes reference glTF models by stable asset IDs. Entity IDs are gameplay
 * identities and never glTF node indices. Components contain serializable data. */
import { transformData, type TransformData } from '../scene/transform';
export { transformData, type TransformData } from '../scene/transform';
export type EntityTransformOwner = 'gameplay' | 'physics';
export function transformOwner(value: unknown): EntityTransformOwner {
  if (value !== 'gameplay' && value !== 'physics')
    throw new Error('Invalid entity transform owner.');
  return value;
}
export interface EntityDefinition {
  id: string;
  name?: string;
  parent?: string;
  transform?: Partial<TransformData>;
  transformOwner?: EntityTransformOwner;
  model?: { asset: string };
  components?: Record<string, JsonValue>;
}
export interface SceneDocument {
  version: 1;
  assets: Record<string, string>;
  entities: EntityDefinition[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field ${key}.`);
}
export function entityDefinition(value: unknown): EntityDefinition {
  const source = record(value, 'Entity');
  fields(
    source,
    ['id', 'name', 'parent', 'transform', 'transformOwner', 'model', 'components'],
    'entity',
  );
  const id = identifier(source.id);
  if (source.name !== undefined && typeof source.name !== 'string')
    throw new Error('Entity name must be a string.');
  const parent = source.parent === undefined ? undefined : identifier(source.parent);
  let model: EntityDefinition['model'];
  if (source.model !== undefined) {
    const reference = record(source.model, 'Model reference');
    fields(reference, ['asset'], 'model reference');
    model = { asset: identifier(reference.asset) };
  }
  const components =
    source.components === undefined
      ? {}
      : copyJson(record(source.components, 'Components') as Record<string, JsonValue>);
  return {
    id,
    ...(source.name !== undefined ? { name: source.name as string } : {}),
    ...(parent !== undefined ? { parent } : {}),
    transform: transformData(source.transform),
    ...(source.transformOwner !== undefined
      ? { transformOwner: transformOwner(source.transformOwner) }
      : {}),
    ...(model ? { model } : {}),
    components,
  };
}

/** Validate before loading assets or publishing a world. Parents may appear later in
 * the file, but missing parents, duplicate IDs and cycles are rejected atomically. */
export function parseSceneDocument(value: unknown, components?: ComponentRegistry): SceneDocument {
  const source = record(typeof value === 'string' ? JSON.parse(value) : value, 'Scene');
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
