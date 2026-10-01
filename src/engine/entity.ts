import { mat4, type ReadonlyMat4, type quat, type vec3 } from 'gl-matrix';
import type { ModelInstance } from './model';
import {
  copyJson,
  transformData,
  type EntityDefinition,
  type JsonValue,
  type TransformData,
} from './scene-document';

/** A gameplay identity owns a model instance containing any number of glTF nodes.
 * Its transform is outside animation, so selecting/resetting a clip cannot move it. */
export class Entity {
  private value: TransformData;
  private components: Record<string, JsonValue>;
  private world = mat4.create();
  private local = mat4.create();
  constructor(
    readonly id: string,
    readonly name: string | undefined,
    definition: EntityDefinition,
    readonly model?: ModelInstance,
  ) {
    this.value = transformData(definition.transform);
    this.components = copyJson(definition.components ?? {});
  }
  get transform(): TransformData {
    return transformData(this.value);
  }
  get worldMatrix(): mat4 {
    return mat4.clone(this.world);
  }
  setTransform(patch: Partial<TransformData>): void {
    this.value = transformData({ ...this.value, ...patch });
  }
  getComponent(key: string): JsonValue | undefined {
    return Object.hasOwn(this.components, key) ? copyJson(this.components[key]) : undefined;
  }
  setComponent(key: string, value: JsonValue): void {
    Object.defineProperty(this.components, key, {
      value: copyJson(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  removeComponent(key: string): void {
    delete this.components[key];
  }
  /** World-only hierarchy evaluation; exposing a matrix copy prevents mutation bypass. */
  updateWorld(parent?: ReadonlyMat4): void {
    mat4.fromRotationTranslationScale(
      this.local,
      this.value.rotation as quat,
      this.value.translation as vec3,
      this.value.scale as vec3,
    );
    if (parent) mat4.multiply(this.world, parent, this.local);
    else mat4.copy(this.world, this.local);
    if ([...this.world].some((v) => !Number.isFinite(v)))
      throw new Error('Entity world transform exceeds float32 range.');
  }
  definition(parent?: string): EntityDefinition {
    return {
      id: this.id,
      ...(this.name !== undefined ? { name: this.name } : {}),
      ...(parent !== undefined ? { parent } : {}),
      transform: this.transform,
      ...(this.model ? { model: { asset: this.model.assetId } } : {}),
      components: copyJson(this.components),
    };
  }
}
