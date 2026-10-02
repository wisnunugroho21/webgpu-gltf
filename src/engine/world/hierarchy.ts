import type { Entity } from './entity';
import { validateParents } from './validation';

export interface HierarchyEntry {
  entity: Entity;
  parent?: Entity;
  index: number;
  end: number;
}

/** Topology only: child adjacency, parent-first order and transactional candidates.
 * Dirty transform evaluation is the World's responsibility, not a graph mutation. */
export class EntityHierarchy {
  private records = new Map<string, Entity>();
  private parents = new Map<string, string>();
  private children = new Map<string, Set<string>>();
  private roots = new Set<string>();
  private ranks?: Map<Entity, number>;
  private entries: HierarchyEntry[] = [];
  traversalRebuilds = 0;

  get size(): number {
    return this.records.size;
  }
  values(): IterableIterator<Entity> {
    return this.records.values();
  }
  has(entity: Entity): boolean {
    return this.records.get(entity.id) === entity;
  }
  get(id: string): Entity {
    const entity = this.records.get(id);
    if (!entity) throw new Error(`Unknown entity ${id}.`);
    return entity;
  }
  parentId(id: string): string | undefined {
    return this.parents.get(id);
  }
  add(entity: Entity, parent?: string, staged = false): void {
    if (this.records.has(entity.id)) throw new Error(`Duplicate entity ${entity.id}.`);
    if (parent !== undefined && !staged) this.get(parent);
    this.records.set(entity.id, entity);
    this.link(entity.id, parent);
    this.invalidate();
  }
  private invalidate(): void {
    this.ranks = undefined;
    // Release removed entity references even if an emptied world never evaluates again.
    this.entries = [];
  }
  private link(id: string, parent?: string): void {
    if (parent === undefined) this.roots.add(id);
    else {
      this.parents.set(id, parent);
      let list = this.children.get(parent);
      if (!list) this.children.set(parent, (list = new Set()));
      list.add(id);
    }
  }
  private unlink(id: string): void {
    const parent = this.parents.get(id);
    if (parent !== undefined) {
      const siblings = this.children.get(parent);
      siblings?.delete(id);
      if (!siblings?.size) this.children.delete(parent);
    } else this.roots.delete(id);
    this.parents.delete(id);
  }
  reparent(id: string, parent?: string, staged = false): boolean {
    this.get(id);
    if (this.parents.get(id) === parent) return false;
    if (!staged) {
      let ancestor = parent;
      while (ancestor !== undefined) {
        this.get(ancestor);
        if (ancestor === id) throw new Error('Cycle in entity hierarchy.');
        ancestor = this.parents.get(ancestor);
      }
    }
    this.unlink(id);
    this.link(id, parent);
    this.invalidate();
    return true;
  }
  removeSubtree(id: string): Entity[] {
    this.get(id);
    const ids = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      // Staged batches can contain intermediate cycles; destruction still terminates.
      if (ids.has(current)) continue;
      ids.add(current);
      for (const child of this.children.get(current) ?? []) stack.push(child);
    }
    const removed: Entity[] = [];
    for (const current of ids) {
      removed.push(this.get(current));
      this.unlink(current);
      this.children.delete(current);
      this.records.delete(current);
    }
    this.invalidate();
    return removed;
  }
  clone(): EntityHierarchy {
    const candidate = new EntityHierarchy();
    candidate.records = new Map(this.records);
    candidate.parents = new Map(this.parents);
    candidate.children = new Map(
      [...this.children].map(([id, children]) => [id, new Set(children)]),
    );
    candidate.roots = new Set(this.roots);
    candidate.traversalRebuilds = this.traversalRebuilds;
    return candidate;
  }
  validate(): void {
    validateParents(new Map([...this.records.keys()].map((id) => [id, this.parents.get(id)])));
  }
  /** Cached preorder entries have contiguous subtree ranges; evaluation can skip
   * an unchanged branch without enumerating its descendants. */
  entry(index: number): HierarchyEntry {
    return this.entries[index];
  }
  /** Rebuild lazily after topology edits, then sort only explicitly dirty roots. */
  orderDirty(dirty: readonly Entity[]): HierarchyEntry[] {
    if (!this.ranks) {
      const ranks = new Map<Entity, number>();
      const entries: HierarchyEntry[] = [];
      const stack: { id: string; parent?: Entity; exit?: HierarchyEntry }[] = [...this.roots]
        .reverse()
        .map((id) => ({ id }));
      while (stack.length) {
        const { id, parent, exit } = stack.pop()!;
        if (exit) {
          exit.end = entries.length;
          continue;
        }
        const entity = this.get(id);
        const entry = { entity, parent, index: entries.length, end: 0 };
        entries.push(entry);
        ranks.set(entity, entry.index);
        stack.push({ id, exit: entry });
        const children = [...(this.children.get(id) ?? [])];
        for (let i = children.length - 1; i >= 0; i--)
          stack.push({ id: children[i], parent: entity });
      }
      this.ranks = ranks;
      this.entries = entries;
      this.traversalRebuilds++;
    }
    const ranks = this.ranks;
    return dirty
      .map((entity) => this.entries[ranks.get(entity)!])
      .sort((a, b) => a.index - b.index);
  }
}
