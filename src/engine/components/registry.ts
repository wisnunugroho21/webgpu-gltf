import { identifier, copyJson, type JsonValue } from '../serialization/json';

export interface ComponentSchema<T> {
  /** Validate persisted JSON and return serializable data (including optional defaults). */
  parse(value: JsonValue, path: string): T;
}
/** Opt-in versioned JSON; existing unversioned component contracts remain valid. */
export interface VersionedComponentSchema<
  T extends { version: number },
> extends ComponentSchema<T> {
  readonly version: number;
  /** Migrate an older payload privately; missing version denotes legacy version 0. */
  migrate?(value: JsonValue, fromVersion: number, path: string): JsonValue;
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
  registerVersioned<T extends { version: number }>(
    key: string,
    schema: VersionedComponentSchema<T>,
  ): ComponentType<T> {
    const version = schema.version;
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Component schema version must be a positive integer.');
    if (typeof schema.parse !== 'function') throw new Error(`Component ${key} requires a parser.`);
    const parse = schema.parse.bind(schema);
    const migrate = schema.migrate?.bind(schema);
    return this.register(key, {
      parse(value, path) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Versioned component must be an object.');
        const sourceVersion = Object.hasOwn(value, 'version') ? value.version : 0;
        if (
          !Number.isSafeInteger(sourceVersion) ||
          (sourceVersion as number) < 0 ||
          (sourceVersion as number) > version
        )
          throw new Error(`Unsupported component version ${String(sourceVersion)}.`);
        let current = value;
        if (sourceVersion !== version) {
          if (!migrate) throw new Error(`Component requires version ${version}.`);
          const migrated = copyJson(migrate(value, sourceVersion as number, path));
          if (
            !migrated ||
            typeof migrated !== 'object' ||
            Array.isArray(migrated) ||
            migrated.version !== version
          )
            throw new Error(`Component migration must produce version ${version}.`);
          current = migrated;
        }
        const result = parse(current, path);
        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          result.version !== version
        )
          throw new Error(`Component parser must preserve version ${version}.`);
        return result;
      },
    });
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
