import { Entity } from './entity';
import { ModelInstance, ModelLibrary } from './model';
import {
  entityDefinition,
  parseSceneDocument,
  type EntityDefinition,
  type SceneDocument,
} from './scene-document';

/** CPU gameplay world. Entity hierarchy and model node hierarchy are independent;
 * each entity world matrix becomes an external root transform for its model. */
export class World {
  private records = new Map<string, Entity>();
  private parents = new Map<string, string>();
  private structure = 0;
  private poses = 0;
  private modelRevisions = new WeakMap<ModelInstance, number>();
  constructor(readonly models = new ModelLibrary()) {}
  get structureRevision(): number {
    return this.structure;
  }
  get poseRevision(): number {
    return this.poses;
  }
  get entities(): readonly Entity[] {
    return [...this.records.values()];
  }
  get modelInstances(): readonly ModelInstance[] {
    return this.entities.flatMap((entity) => (entity.model ? [entity.model] : []));
  }
  getEntity(id: string): Entity {
    const entity = this.records.get(id);
    if (!entity) throw new Error(`Unknown entity ${id}.`);
    return entity;
  }
  createEntity(source: EntityDefinition): Entity {
    const definition = entityDefinition(source);
    if (this.records.has(definition.id)) throw new Error(`Duplicate entity ${definition.id}.`);
    if (definition.parent !== undefined) this.getEntity(definition.parent);
    const model = definition.model
      ? new ModelInstance(definition.model.asset, this.models.getModel(definition.model.asset))
      : undefined;
    const entity = new Entity(definition.id, definition.name, definition, model);
    this.records.set(entity.id, entity);
    if (definition.parent !== undefined) this.parents.set(entity.id, definition.parent);
    this.structure++;
    return entity;
  }
  setParent(id: string, parent?: string): void {
    this.getEntity(id);
    let ancestor = parent;
    while (ancestor !== undefined) {
      this.getEntity(ancestor);
      if (ancestor === id) throw new Error('Cycle in entity hierarchy.');
      ancestor = this.parents.get(ancestor);
    }
    if (parent === undefined) this.parents.delete(id);
    else this.parents.set(id, parent);
  }
  /** Destroy a gameplay subtree. GPU membership changes commit with setWorld(). */
  destroyEntity(id: string): void {
    this.getEntity(id);
    for (const [child, parent] of [...this.parents]) if (parent === id) this.destroyEntity(child);
    this.parents.delete(id);
    this.records.delete(id);
    this.structure++;
  }
  updateTransforms(): void {
    const visited = new Set<string>();
    const visit = (entity: Entity) => {
      if (visited.has(entity.id)) return;
      const parentId = this.parents.get(entity.id);
      const parent = parentId === undefined ? undefined : this.getEntity(parentId);
      if (parent) visit(parent);
      entity.updateWorld(parent?.worldMatrix);
      if (entity.model) {
        entity.model.pose.setRootTransform(entity.worldMatrix);
        const revision = entity.model.pose.revision;
        if (revision !== this.modelRevisions.get(entity.model)) {
          this.modelRevisions.set(entity.model, revision);
          this.poses++;
        }
      }
      visited.add(entity.id);
    };
    for (const entity of this.records.values()) visit(entity);
  }
  /** Called by rendering preparation, or explicitly by CPU-only simulations. A
   * revision survives repeated evaluation so the renderer never loses dirty work. */
  update(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) throw new Error('World timestamp must be finite.');
    for (const entity of this.records.values()) entity.model?.animation.update(timestampMs);
    this.updateTransforms();
  }
  toDocument(): SceneDocument {
    return {
      version: 1,
      assets: this.models.references(),
      entities: this.entities.map((entity) => entity.definition(this.parents.get(entity.id))),
    };
  }
  static fromDocument(value: unknown, models: ModelLibrary): World {
    const document = parseSceneDocument(value);
    const references = models.references();
    for (const [id, uri] of Object.entries(document.assets))
      if (references[id] !== uri)
        throw new Error(`Model library does not match scene asset ${id}.`);
    const world = new World(models);
    for (const definition of document.entities)
      world.createEntity({ ...definition, parent: undefined });
    for (const definition of document.entities)
      if (definition.parent !== undefined) world.setParent(definition.id, definition.parent);
    world.updateTransforms();
    return world;
  }
}
