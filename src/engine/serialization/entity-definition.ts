import { identifier, copyJson, type JsonValue } from './json';
import { transformData, type TransformData } from '../../scene/transform';
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

export function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
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
