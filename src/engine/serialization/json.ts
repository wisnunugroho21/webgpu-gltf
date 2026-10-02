export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('IDs must be nonempty strings.');
  return value;
}
function jsonRecord(item: object): Record<string, unknown> {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
    throw new Error('Component must be a JSON object.');
  return item as Record<string, unknown>;
}
export function copyJson<T extends JsonValue>(value: T): T {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item))
      throw new Error('Component data must be finite, acyclic JSON.');
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(jsonRecord(item))) visit(child);
    seen.delete(item);
  };
  visit(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
