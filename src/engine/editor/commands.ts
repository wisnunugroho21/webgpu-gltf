import type { WorldChange } from '../world';
import { entityDefinition, type JsonValue, type TransformData } from '../scene-document';
import { copyJson, identifier } from '../serialization/json';

/** Commands describe supported authoring operations, not renderer internals.
 * Structural changes form one atomic World.applyChanges batch. */
export type EditorCommand =
  | { readonly type: 'set-transform'; readonly id: string; readonly patch: Partial<TransformData> }
  | {
      readonly type: 'set-component';
      readonly id: string;
      readonly key: string;
      readonly value: JsonValue;
    }
  | { readonly type: 'remove-component'; readonly id: string; readonly key: string }
  | { readonly type: 'membership'; readonly changes: readonly WorldChange[] };

export interface EditorResult {
  /** The adapter must await renderer.syncWorld before resuming submissions. */
  readonly membershipChanged: boolean;
}

/** Copy only the public command fields. Optional parent absence is normalized;
 * callers cannot inject the private playback-restoration payload used by history. */
export function copyEditorCommand(command: EditorCommand): EditorCommand {
  if (command.type === 'membership')
    return {
      type: 'membership',
      changes: command.changes.map((change) => {
        if (change.type === 'create')
          return { type: 'create', entity: entityDefinition(change.entity) };
        if (change.type === 'destroy') return { type: 'destroy', id: identifier(change.id) };
        if (change.type === 'reparent')
          return {
            type: 'reparent',
            id: identifier(change.id),
            ...(change.parent === undefined ? {} : { parent: identifier(change.parent) }),
          };
        throw new Error('Unknown world structural change.');
      }),
    };
  const id = identifier(command.id);
  if (command.type === 'set-transform')
    return {
      type: 'set-transform',
      id,
      patch: copyJson(command.patch as unknown as JsonValue) as Partial<TransformData>,
    };
  if (command.type === 'set-component')
    return {
      type: 'set-component',
      id,
      key: identifier(command.key),
      value: copyJson(command.value),
    };
  if (command.type === 'remove-component')
    return { type: 'remove-component', id, key: identifier(command.key) };
  throw new Error('Unknown editor command.');
}
