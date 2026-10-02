export interface ActionState {
  readonly held: boolean;
  readonly pressed: boolean;
  readonly released: boolean;
}

/** Edges survive frames without simulation. Only consume() advances the input
 * boundary, so catch-up steps see each edge once. Sources support key aliases. */
export class ActionInput {
  private sources = new Map<string, Set<string>>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  set(action: string, down: boolean, source = action): void {
    const sources = this.sources.get(action) ?? new Set<string>();
    const before = sources.size > 0;
    if (down) sources.add(source);
    else sources.delete(source);
    this.sources.set(action, sources);
    const after = sources.size > 0;
    if (!before && after) this.pressed.add(action);
    if (before && !after) this.released.add(action);
  }
  consume(): ReadonlyMap<string, ActionState> {
    const result = new Map<string, ActionState>();
    for (const [action, sources] of this.sources)
      result.set(
        action,
        Object.freeze({
          held: sources.size > 0,
          pressed: this.pressed.has(action),
          released: this.released.has(action),
        }),
      );
    this.pressed.clear();
    this.released.clear();
    return result;
  }
  clear(): void {
    this.sources.clear();
    this.pressed.clear();
    this.released.clear();
  }
}
