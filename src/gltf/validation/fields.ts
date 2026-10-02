export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
}
export function array(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected an array.');
}
export function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error('Expected a nonnegative safe integer.');
}
export function ref(value: unknown, items: unknown[] | undefined): void {
  integer(value);
  if (!items || value >= items.length) throw new Error(`Missing referenced index ${value}.`);
}
export function vector(value: unknown, length?: number): void {
  array(value);
  if (
    (length !== undefined && value.length !== length) ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    throw new Error('Expected a finite numeric vector of the correct length.');
}
