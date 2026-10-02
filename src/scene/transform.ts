export interface TransformData {
  translation: number[];
  rotation: number[];
  scale: number[];
}
export type TransformField = keyof TransformData;

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field ${key}.`);
}

/** Copy data at API boundaries so caller mutation cannot bypass transform revisions. */
export function transformData(value: unknown = {}): TransformData {
  const source = record(value, 'Transform');
  fields(source, ['translation', 'rotation', 'scale'], 'transform');
  const vector = (key: string, defaults: number[]) => {
    const values = source[key] ?? defaults;
    if (
      !Array.isArray(values) ||
      values.length !== defaults.length ||
      values.some(
        (v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 3.402823466e38,
      )
    )
      throw new Error(`Invalid transform ${key}.`);
    return [...values] as number[];
  };
  const translation = vector('translation', [0, 0, 0]);
  const rotation = vector('rotation', [0, 0, 0, 1]);
  const scale = vector('scale', [1, 1, 1]);
  const length = Math.hypot(...rotation);
  if (length < 1e-8 || scale.some((v) => v === 0))
    throw new Error('Transform must have a valid rotation and nonzero scale.');
  for (let c = 0; c < 4; c++) rotation[c] /= length;
  return { translation, rotation, scale };
}
