import {
  ComponentRegistry,
  ComponentValidationError,
  type ComponentType,
} from '../components/registry';
import { mat4, type quat, type vec3 } from 'gl-matrix';
import type { ModelInstance } from '../model';
import {
  transformData,
  transformOwner,
  type EntityTransformOwner,
  type EntityDefinition,
  type JsonValue,
  type TransformData,
} from '../scene-document';

/** A gameplay identity owns a model instance containing any number of glTF nodes.
 * Its transform is outside animation, so selecting/resetting a clip cannot move it. */
export class Entity {
  private value: TransformData;
  private components: Record<string, JsonValue>;
  private world = mat4.create();
  private local = mat4.create();
  private candidate = mat4.create();
  private localVersion = 0;
  private worldVersion = 0;
  private appliedLocal = -1;
  private appliedParent?: Entity;
  private appliedParentWorld = -1;
  private modelWorldRevision = -1;
  private evaluationEpoch = 0;
  /** Internal per-evaluation marker deduplicates overlapping dirty subtrees. */
  beginEvaluation(epoch: number): boolean {
    if (this.evaluationEpoch === epoch) return false;
    this.evaluationEpoch = epoch;
    return true;
  }
  get localRevision(): number {
    return this.localVersion;
  }
  get worldRevision(): number {
    return this.worldVersion;
  }
  get parentWorldRevision(): number {
    return this.appliedParentWorld;
  }
  private owner: EntityTransformOwner;
  constructor(
    readonly id: string,
    readonly name: string | undefined,
    definition: EntityDefinition,
    readonly model?: ModelInstance,
    private onTransform?: (entity: Entity) => void,
    private componentRegistry = new ComponentRegistry(),
  ) {
    this.value = transformData(definition.transform);
    this.owner = transformOwner(definition.transformOwner ?? 'gameplay');
    this.components = this.componentRegistry.validateAll(
      definition.components ?? {},
      `entities[${JSON.stringify(this.id)}]`,
    );
  }
  get transform(): TransformData {
    return transformData(this.value);
  }
  get worldMatrix(): mat4 {
    return mat4.clone(this.world);
  }
  get transformOwner(): EntityTransformOwner {
    return this.owner;
  }
  /** Explicit handoff prevents gameplay and physics from silently competing for
   * the same root. Handoff preserves placement; it never writes animation locals. */
  setTransformOwner(owner: EntityTransformOwner): void {
    this.owner = transformOwner(owner);
  }
  setTransform(patch: Partial<TransformData>, writer: EntityTransformOwner = 'gameplay'): void {
    if (transformOwner(writer) !== this.owner)
      throw new Error(`Entity ${this.id} root is owned by ${this.owner}, not ${writer}.`);
    const next = transformData({ ...this.value, ...patch });
    if (
      (['translation', 'rotation', 'scale'] as const).every((field) =>
        next[field].every((value, index) => value === this.value[field][index]),
      )
    )
      return;
    this.value = next;
    this.localVersion++;
    this.onTransform?.(this);
  }
  getComponent<T>(type: ComponentType<T>): T | undefined;
  getComponent(key: string): JsonValue | undefined;
  getComponent(keyOrType: string | ComponentType<unknown>): unknown {
    if (typeof keyOrType !== 'string') this.componentRegistry.assertType(keyOrType);
    const key = typeof keyOrType === 'string' ? keyOrType : keyOrType.key;
    return Object.hasOwn(this.components, key)
      ? this.componentRegistry.validate(
          key,
          this.components[key],
          `entities[${JSON.stringify(this.id)}].components[${JSON.stringify(key)}]`,
        )
      : undefined;
  }
  requireComponent<T>(type: ComponentType<T>): T {
    const value = this.getComponent(type);
    if (value === undefined)
      throw new ComponentValidationError(
        `entities[${JSON.stringify(this.id)}].components[${JSON.stringify(type.key)}]`,
        new Error('Required component is missing.'),
      );
    return value;
  }
  setComponent<T>(type: ComponentType<T>, value: T): void;
  setComponent(key: string, value: JsonValue): void;
  setComponent(keyOrType: string | ComponentType<unknown>, value: unknown): void {
    if (typeof keyOrType !== 'string') this.componentRegistry.assertType(keyOrType);
    const key = typeof keyOrType === 'string' ? keyOrType : keyOrType.key;
    Object.defineProperty(this.components, key, {
      value: this.componentRegistry.validate(
        key,
        value,
        `entities[${JSON.stringify(this.id)}].components[${JSON.stringify(key)}]`,
      ),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  removeComponent(keyOrType: string | ComponentType<unknown>): void {
    if (typeof keyOrType !== 'string') this.componentRegistry.assertType(keyOrType);
    delete this.components[typeof keyOrType === 'string' ? keyOrType : keyOrType.key];
  }
  /** Internal world evaluation borrows the parent's matrix within this class;
   * public getters still return copies. Local matrices survive parent-only motion. */
  needsWorldUpdate(parent?: Entity): boolean {
    return (
      this.appliedLocal !== this.localVersion ||
      this.appliedParent !== parent ||
      this.appliedParentWorld !== (parent?.worldVersion ?? 0)
    );
  }
  updateWorld(parent?: Entity): boolean {
    if (this.appliedLocal !== this.localVersion)
      mat4.fromRotationTranslationScale(
        this.local,
        this.value.rotation as quat,
        this.value.translation as vec3,
        this.value.scale as vec3,
      );
    if (parent) mat4.multiply(this.candidate, parent.world, this.local);
    else mat4.copy(this.candidate, this.local);
    for (let i = 0; i < 16; i++)
      if (!Number.isFinite(this.candidate[i]))
        throw new Error('Entity world transform exceeds float32 range.');
    let changed = this.worldVersion === 0;
    for (let i = 0; i < 16; i++) changed ||= this.world[i] !== this.candidate[i];
    if (changed) {
      mat4.copy(this.world, this.candidate);
      this.worldVersion++;
    }
    this.appliedLocal = this.localVersion;
    this.appliedParent = parent;
    this.appliedParentWorld = parent?.worldVersion ?? 0;
    return changed;
  }
  /** Internal synchronization avoids allocating an entity matrix copy per model. */
  syncModelRoot(): boolean {
    if (!this.model || this.modelWorldRevision === this.worldVersion) return false;
    this.model.pose.setRootTransform(this.world);
    this.modelWorldRevision = this.worldVersion;
    return true;
  }
  detach(): void {
    this.onTransform = undefined;
  }
  definition(parent?: string): EntityDefinition {
    return {
      id: this.id,
      ...(this.name !== undefined ? { name: this.name } : {}),
      ...(parent !== undefined ? { parent } : {}),
      transform: this.transform,
      ...(this.owner === 'physics' ? { transformOwner: this.owner } : {}),
      ...(this.model ? { model: { asset: this.model.assetId } } : {}),
      components: this.componentRegistry.validateAll(
        this.components,
        `entities[${JSON.stringify(this.id)}]`,
      ),
    };
  }
}
