/** Reachability only: include seeds and descendants once, tolerating overlaps and
 * cycles. This is not topology validation or a parent-first ordering primitive.
 * Pose uses it after forest validation; entity deletion also needs it while staged
 * mutations may temporarily form a cycle. Children are enumerated by the owner. */
export function descendantClosure<T>(
  roots: Iterable<T>,
  children: (node: T) => Iterable<T>,
): Set<T> {
  const result = new Set<T>();
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (result.has(node)) continue;
    result.add(node);
    for (const child of children(node)) pending.push(child);
  }
  return result;
}
