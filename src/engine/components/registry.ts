import { identifier, copyJson, type JsonValue } from '../serialization/json';

export interface ComponentSchema<T> {
  /** Validate persisted JSON and return serializable data (including optional defaults). */
  parse(value: JsonValue, path: string): T;
}
export interface ComponentType<T> {
  readonly key: string;
  readonly schema: ComponentSchema<T>;
}
export type UnknownComponentPolicy = 'preserve' | 'reject';
export class ComponentValidationError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ComponentValidationError';
  }
}

/** Registered schemas are scoped to a world/application. Unknown JSON is preserved
 * by default so authoring data can round-trip before its gameplay service is installed. */
export class ComponentRegistry {
  private types = new Map<string, ComponentType<unknown>>();
  constructor(readonly unknown: UnknownComponentPolicy = 'preserve') {
    if (unknown !== 'preserve' && unknown !== 'reject')
      throw new Error('Invalid unknown component policy.');
  }
  register<T>(key: string, schema: ComponentSchema<T>): ComponentType<T> {
    identifier(key);
    if (this.types.has(key)) throw new Error(`Component schema ${key} is already registered.`);
    if (typeof schema.parse !== 'function') throw new Error(`Component ${key} requires a parser.`);
    const type = Object.freeze({
      key,
      schema: Object.freeze({ parse: schema.parse.bind(schema) }),
    });
    this.types.set(key, type);
    return type;
  }
  assertType<T>(type: ComponentType<T>): void {
    if (this.types.get(type.key) !== type)
      throw new Error(`Component type ${type.key} belongs to another registry.`);
  }
  validate(key: string, value: unknown, path: string): JsonValue {
    try {
      const source = copyJson(value as JsonValue);
      const type = this.types.get(key);
      if (!type) {
        if (this.unknown === 'reject') throw new Error(`Unknown component ${key}.`);
        return source;
      }
      // Parsers receive a copy; their returned defaults/canonical data are copied again.
      return copyJson(type.schema.parse(source, path) as JsonValue);
    } catch (error) {
      throw new ComponentValidationError(path, error);
    }
  }
  validateAll(values: Record<string, JsonValue>, entityPath: string): Record<string, JsonValue> {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, value] of Object.entries(values))
      result[key] = this.validate(key, value, `${entityPath}.components[${JSON.stringify(key)}]`);
    return result;
  }
}
