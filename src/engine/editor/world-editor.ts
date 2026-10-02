import type { Entity } from '../entity';
import type { World, WorldChange } from '../world';
import { identifier } from '../serialization/json';
import { transformData, type SceneDocument } from '../scene-document';
import { captureSaveState, type SaveState } from '../serialization/save-state';
import { copyEditorCommand, type EditorCommand, type EditorResult } from './commands';

type ModelState = SaveState['models'][string];
type Edit = EditorCommand & { readonly restore?: Readonly<Record<string, ModelState>> };
interface Stamp {
  entities: readonly Entity[];
  document: string;
}

/** CPU authoring owner for a paused world. It never schedules simulation or GPU
 * work. History contains detached inverse data, with a bounded number of entries.
 * An external edit/replaced entity invalidates history instead of being overwritten.
 * Animation clocks can continue independently; deleted instances capture their
 * latest playback and overrides when the inverse is prepared. */
export class WorldEditor {
  private past: Edit[] = [];
  private future: Edit[] = [];
  private expected: Stamp;
  private selected: string[] = [];
  constructor(
    readonly world: World,
    readonly historyLimit = 50,
  ) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 256)
      throw new Error('Editor history limit must be an integer from 1 to 256.');
    this.expected = this.stamp();
  }
  private stamp(): Stamp {
    return { entities: this.world.entities, document: JSON.stringify(this.world.toDocument()) };
  }
  private assertCurrent(): void {
    const current = this.stamp();
    if (
      current.document !== this.expected.document ||
      current.entities.length !== this.expected.entities.length ||
      current.entities.some((entity, i) => entity !== this.expected.entities[i])
    )
      throw new Error('World changed outside the editor; clear history before editing again.');
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get selection(): readonly string[] {
    const live = new Set(this.world.entities.map((entity) => entity.id));
    this.selected = this.selected.filter((id) => live.has(id));
    return [...this.selected];
  }
  select(ids: readonly string[]): void {
    // Validate the entire selection before publication.
    for (const id of ids) this.world.getEntity(id);
    this.selected = [...new Set(ids)];
  }
  clearHistory(): void {
    const current = this.stamp();
    this.past = [];
    this.future = [];
    this.expected = current;
  }
  /** Flat scene export stays version 1; prefab source documents remain separate.
   * Asset URIs and component version fields pass through the existing validation. */
  exportScene(): SceneDocument {
    return this.world.toDocument();
  }
  execute(command: EditorCommand): EditorResult {
    this.assertCurrent();
    const revision = this.world.structureRevision;
    const inverse = this.apply(copyEditorCommand(command));
    const current = this.stamp();
    if (
      current.document === this.expected.document &&
      current.entities.every((entity, i) => entity === this.expected.entities[i])
    )
      return { membershipChanged: false };
    this.past.push(inverse);
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
    this.expected = current;
    return { membershipChanged: revision !== this.world.structureRevision };
  }
  undo(): EditorResult {
    return this.travel(this.past, this.future);
  }
  redo(): EditorResult {
    return this.travel(this.future, this.past);
  }
  private travel(from: Edit[], to: Edit[]): EditorResult {
    this.assertCurrent();
    if (!from.length) throw new Error('No editor command to replay.');
    const revision = this.world.structureRevision;
    const inverse = this.apply(from[from.length - 1]);
    from.pop();
    to.push(inverse);
    this.expected = this.stamp();
    return { membershipChanged: revision !== this.world.structureRevision };
  }
  private apply(edit: Edit): Edit {
    if (edit.type === 'membership') return this.membership(edit);
    const entity = this.world.getEntity(edit.id);
    if (edit.type === 'set-transform') {
      const before = entity.transform;
      const next = transformData({ ...before, ...edit.patch });
      // A paused editor still cannot impersonate the physics transform owner.
      entity.setTransform(next);
      return { type: 'set-transform', id: entity.id, patch: before };
    }
    if (edit.type !== 'set-component' && edit.type !== 'remove-component')
      throw new Error('Unknown editor command.');
    const key = identifier(edit.key);
    const before = entity.getComponent(key);
    if (edit.type === 'set-component') entity.setComponent(key, edit.value);
    else entity.removeComponent(key);
    return before === undefined
      ? { type: 'remove-component', id: entity.id, key }
      : { type: 'set-component', id: entity.id, key, value: before };
  }
  private membership(edit: Extract<Edit, { type: 'membership' }>): Edit {
    // Capture before publication so validation/serialization failure leaves the
    // live hierarchy intact. Only removed entities' state enters undo history.
    const saved = captureSaveState(this.world);
    const before = new Map(this.world.entities.map((entity) => [entity.id, entity]));
    const definitions = new Map(saved.scene.entities.map((entity) => [entity.id, entity]));
    this.world.applyChanges(edit.changes, (entity) => {
      const state = edit.restore?.[entity.id];
      if (!state) return;
      if (!entity.model) throw new Error('Editor model state requires a model.');
      entity.model.animation.restore(state.animation);
      for (const [node, override] of Object.entries(state.overrides))
        entity.model.setNodeOverride(Number(node), override);
    });
    const after = new Map(this.world.entities.map((entity) => [entity.id, entity]));
    const added = new Set([...after.values()].filter((entity) => before.get(entity.id) !== entity));
    const removed = [...before.values()].filter((entity) => after.get(entity.id) !== entity);
    const survivors = [...after.values()].filter((entity) => before.get(entity.id) === entity);
    const reparented = survivors.filter(
      (entity) =>
        this.world.getParent(entity.id)?.id !== definitions.get(entity.id)!.parent ||
        added.has(this.world.getParent(entity.id)!),
    );
    const changes: WorldChange[] = [];
    // Detach survivors first so deleting added parents cannot delete surviving
    // children. Intermediate missing parents are allowed inside the atomic batch.
    for (const entity of reparented) changes.push({ type: 'reparent', id: entity.id });
    for (const entity of added)
      if (!added.has(this.world.getParent(entity.id)!))
        changes.push({ type: 'destroy', id: entity.id });
    const restore: Record<string, ModelState> = Object.create(null);
    for (const entity of removed) {
      const definition = definitions.get(entity.id)!;
      changes.push({ type: 'create', entity: definition });
      if (Object.hasOwn(saved.models, entity.id)) restore[entity.id] = saved.models[entity.id];
    }
    for (const entity of reparented)
      changes.push({ type: 'reparent', id: entity.id, parent: definitions.get(entity.id)!.parent });
    return { type: 'membership', changes, restore };
  }
}
