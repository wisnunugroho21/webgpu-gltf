/** Linear, iterative validation shared by scene decoding and structural batches.
 * Each parent chain is marked once; deep scenes do not require recursion or a
 * fresh ancestor walk for every entity. Roots may be stored with undefined parents. */
export function validateParents(parents: ReadonlyMap<string, string | undefined>): void {
  for (const parent of parents.values())
    if (parent !== undefined && !parents.has(parent)) throw new Error(`Missing parent ${parent}.`);
  const state = new Map<string, number>();
  for (const id of parents.keys()) {
    let current: string | undefined = id;
    const path: string[] = [];
    while (current !== undefined && state.get(current) !== 2) {
      if (state.get(current) === 1) throw new Error('Cycle in entity hierarchy.');
      state.set(current, 1);
      path.push(current);
      current = parents.get(current);
    }
    for (const node of path) state.set(node, 2);
  }
}
