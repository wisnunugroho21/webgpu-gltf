import { AssetRegistry } from '../assets/registry';
import { ComponentRegistry } from '../components/registry';
import { ModelInstance, ModelLibrary } from '../model';
import {
  entityDefinition,
  parseSceneDocument,
  type EntityDefinition,
  type SceneDocument,
} from '../scene-document';

import { Entity } from './entity';
import { EntityHierarchy } from './hierarchy';

export type WorldChange =
  | { readonly type: 'create'; readonly entity: EntityDefinition }
  | { readonly type: 'reparent'; readonly id: string; readonly parent?: string }
  | { readonly type: 'destroy'; readonly id: string };

export interface HierarchyStats {
  visitedEntities: number;
  recomputedWorlds: number;
  changedWorlds: number;
  syncedModelRoots: number;
  traversalRebuilds: number;
}

/** CPU gameplay world. Entity hierarchy and model node hierarchy are independent;
 * each entity world matrix becomes an external root transform for its model. */
export class World {
  /** CPU evaluation profiling is owned by the world, independently of rendering. */
  profiling = false;
  private timings = {
    evaluationMs: 0,
    mixingMs: 0,
    worldMs: 0,
    hierarchyMs: 0,
    sampledNodes: 0,
    visitedNodes: 0,
  };
  get cpuTimings() {
    return this.profiling ? { ...this.timings } : undefined;
  }
  private hierarchy = new EntityHierarchy();
  private dirty = new Set<Entity>();
  private instances = new Set<ModelInstance>();
  private structure = 0;
  private topology = 0;
  private poses = 0;
  private evaluationEpoch = 0;
  private modelRevisions = new WeakMap<ModelInstance, number>();
  private stats: HierarchyStats = {
    visitedEntities: 0,
    recomputedWorlds: 0,
    changedWorlds: 0,
    syncedModelRoots: 0,
    traversalRebuilds: 0,
  };
  constructor(
    readonly models: AssetRegistry = new ModelLibrary(),
    readonly components = new ComponentRegistry(),
  ) {}
  get structureRevision(): number {
    return this.structure;
  }
  get hierarchyRevision(): number {
    return this.topology;
  }
  get poseRevision(): number {
    return this.poses;
  }
  get hierarchyStats(): Readonly<HierarchyStats> {
    return { ...this.stats };
  }
  get entities(): readonly Entity[] {
    return [...this.hierarchy.values()];
  }
  get modelInstances(): readonly ModelInstance[] {
    return [...this.instances];
  }
  getEntity(id: string): Entity {
    return this.hierarchy.get(id);
  }
  /** Inspect current parent identity without serializing/traversing the world.
   * Physics adapters must convert world poses using the current parent each step. */
  getParent(id: string): Entity | undefined {
    const parent = this.hierarchy.parentId(this.getEntity(id).id);
    return parent === undefined ? undefined : this.getEntity(parent);
  }
  private markDirty = (entity: Entity): void => {
    if (this.hierarchy.has(entity)) this.dirty.add(entity);
  };
  private makeEntity(definition: EntityDefinition): Entity {
    let model: ModelInstance | undefined;
    if (definition.model) {
      try {
        model = new ModelInstance(
          definition.model.asset,
          this.models.getModel(definition.model.asset),
        );
      } catch (cause) {
        throw new Error(
          `entities[${JSON.stringify(definition.id)}].model.asset (${definition.model.asset}): ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }
    return new Entity(
      definition.id,
      definition.name,
      definition,
      model,
      this.markDirty,
      this.components,
    );
  }
  createEntity(source: EntityDefinition): Entity {
    const definition = entityDefinition(source);
    if (definition.parent !== undefined) this.getEntity(definition.parent);
    const entity = this.makeEntity(definition);
    this.hierarchy.add(entity, definition.parent);
    if (entity.model) this.instances.add(entity.model);
    this.dirty.add(entity);
    this.structure++;
    this.topology++;
    return entity;
  }
  setParent(id: string, parent?: string): void {
    if (this.hierarchy.reparent(id, parent)) {
      this.dirty.add(this.getEntity(id));
      this.topology++;
    }
  }
  /** Iterative subtree removal. GPU membership still commits with setWorld(). */
  destroyEntity(id: string): void {
    for (const entity of this.hierarchy.removeSubtree(id)) {
      this.dirty.delete(entity);
      entity.detach();
      if (entity.model) this.instances.delete(entity.model);
    }
    this.structure++;
    this.topology++;
  }
  /** Explicit atomic structural boundary. Commands run in order on a candidate;
   * final parent presence/cycles are validated before any live entity is published.
   * Create parents later in the same batch when loading unordered scene documents. */
  applyChanges(
    changes: readonly WorldChange[],
    initialize?: (entity: Entity) => void,
  ): readonly Entity[] {
    if (!changes.length) return [];
    const candidate = this.hierarchy.clone();
    const created: Entity[] = [];
    for (const change of changes) {
      if (change.type === 'create') {
        const definition = entityDefinition(change.entity);
        const entity = this.makeEntity(definition);
        // Initialize only this unpublished entity (for example playback/overrides).
        // A failure discards the candidate before any live membership changes.
        initialize?.(entity);
        candidate.add(entity, definition.parent, true);
        created.push(entity);
      } else if (change.type === 'reparent') candidate.reparent(change.id, change.parent, true);
      else if (change.type === 'destroy') candidate.removeSubtree(change.id);
      else throw new Error('Unknown world structural change.');
    }
    candidate.validate();
    const old = this.hierarchy;
    let membershipChanged = candidate.size !== old.size;
    let topologyChanged = membershipChanged;
    const affected: Entity[] = [];
    for (const entity of candidate.values()) {
      const added = !old.has(entity);
      membershipChanged ||= added;
      if (added || old.parentId(entity.id) !== candidate.parentId(entity.id)) {
        topologyChanged = true;
        affected.push(entity);
      }
    }
    if (!topologyChanged) return [];
    // No fallible validation or resource work follows publication.
    this.hierarchy = candidate;
    for (const entity of old.values())
      if (!candidate.has(entity)) {
        this.dirty.delete(entity);
        entity.detach();
      }
    this.instances = new Set(
      [...candidate.values()].flatMap((entity) => (entity.model ? [entity.model] : [])),
    );
    for (const entity of affected) this.dirty.add(entity);
    this.topology++;
    if (membershipChanged) this.structure++;
    return created.filter((entity) => candidate.has(entity));
  }
  updateTransforms(): void {
    const start = this.profiling ? performance.now() : 0;
    const rebuilds = this.hierarchy.traversalRebuilds;
    this.stats = {
      visitedEntities: 0,
      recomputedWorlds: 0,
      changedWorlds: 0,
      syncedModelRoots: 0,
      traversalRebuilds: 0,
    };
    if (this.dirty.size) {
      const roots = this.hierarchy.orderDirty([...this.dirty]);
      const epoch = ++this.evaluationEpoch;
      try {
        for (const root of roots) {
          let index = root.index;
          while (index < root.end) {
            const entry = this.hierarchy.entry(index);
            const { entity, parent } = entry;
            if (!entity.beginEvaluation(epoch)) {
              index = entry.end;
              continue;
            }
            this.stats.visitedEntities++;
            let changed = false;
            if (entity.needsWorldUpdate(parent)) {
              this.stats.recomputedWorlds++;
              changed = entity.updateWorld(parent);
            }
            if (changed) {
              this.stats.changedWorlds++;
            }
            if (entity.syncModelRoot()) this.stats.syncedModelRoots++;
            // Unchanged effective matrices stop propagation. Independently dirty
            // descendants remain in roots and are evaluated later in cached order.
            index = changed ? index + 1 : entry.end;
          }
        }
        this.dirty.clear();
      } catch (error) {
        // Retry every live entity after failure: an already published parent may
        // have unfinished descendants or a failed model synchronization. Each
        // entity preserves its own last finite matrix until a candidate succeeds.
        for (const entity of this.hierarchy.values()) this.dirty.add(entity);
        throw error;
      }
    }
    for (const model of this.instances) {
      const revision = model.pose.revision;
      if (revision !== this.modelRevisions.get(model)) {
        this.modelRevisions.set(model, revision);
        this.poses++;
      }
    }
    this.stats.traversalRebuilds = this.hierarchy.traversalRebuilds - rebuilds;
    if (this.profiling) this.timings.hierarchyMs = performance.now() - start;
  }
  /** Engine-owned presentation evaluation, independent of render frequency. A
   * revision survives repeated evaluation so the renderer never loses dirty work. */
  update(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) throw new Error('World timestamp must be finite.');
    const start = this.profiling ? performance.now() : 0;
    if (this.profiling)
      Object.keys(this.timings).forEach((key) => {
        this.timings[key as keyof typeof this.timings] = 0;
      });
    for (const model of this.instances) {
      model.pose.profiling = this.profiling;
      if (this.profiling)
        Object.assign(model.pose.timings, {
          mixingMs: 0,
          worldMs: 0,
          sampledNodes: 0,
          visitedNodes: 0,
        });
      model.animation.update(timestampMs);
    }
    this.updateTransforms();
    if (this.profiling) {
      this.timings.evaluationMs = performance.now() - start;
      for (const model of this.modelInstances)
        for (const key of ['mixingMs', 'worldMs', 'sampledNodes', 'visitedNodes'] as const)
          this.timings[key] += model.pose.timings[key];
    }
  }
  toDocument(): SceneDocument {
    const references = this.models.references();
    // A registry can serve several worlds. Export only this world's dependencies,
    // so restoring a level never loads unrelated catalog entries.
    const assets: SceneDocument['assets'] = {};
    for (const entity of this.hierarchy.values()) {
      if (!entity.model) continue;
      if (!Object.hasOwn(references, entity.model.assetId))
        throw new Error(
          `entities[${JSON.stringify(entity.id)}].model.asset: declaration ${entity.model.assetId} was forgotten; preserve it with cache eviction instead.`,
        );
      Object.defineProperty(assets, entity.model.assetId, {
        value: references[entity.model.assetId],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return {
      version: 1,
      assets,
      entities: this.entities.map((entity) =>
        entity.definition(this.hierarchy.parentId(entity.id)),
      ),
    };
  }
  static fromDocument(
    value: unknown,
    models: AssetRegistry,
    components = new ComponentRegistry(),
  ): World {
    const document = parseSceneDocument(value, components);
    const references = models.references();
    for (const [id, uri] of Object.entries(document.assets))
      if (references[id] !== uri)
        throw new Error(`Model library does not match scene asset ${id}.`);
    const world = new World(models, components);
    world.applyChanges(document.entities.map((entity) => ({ type: 'create', entity })));
    world.updateTransforms();
    return world;
  }
}
