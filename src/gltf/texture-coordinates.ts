import type { TextureInfo } from './types';

/** Rows of offset * rotation * scale, plus the effective TEXCOORD index. The extension's
 * texCoord overrides the core field. Keeping this pure makes packing and validation testable. */
export function textureCoordinates(info?: TextureInfo): Float32Array {
  const transform = info?.extensions?.KHR_texture_transform;
  const set = transform?.texCoord ?? info?.texCoord ?? 0;
  const offset = transform?.offset ?? [0, 0];
  const scale = transform?.scale ?? [1, 1];
  const rotation = transform?.rotation ?? 0;
  if (!Number.isSafeInteger(set) || set < 0 || set > 16777216)
    throw new Error(
      'Texture coordinate index must be a nonnegative exactly representable integer.',
    );
  if (
    !Array.isArray(offset) ||
    offset.length !== 2 ||
    !offset.every(Number.isFinite) ||
    !Array.isArray(scale) ||
    scale.length !== 2 ||
    !scale.every(Number.isFinite) ||
    !Number.isFinite(rotation)
  )
    throw new Error('Invalid KHR_texture_transform values.');
  const c = Math.cos(rotation),
    s = Math.sin(rotation);
  const values = new Float32Array([
    c * scale[0],
    -s * scale[1],
    offset[0],
    set,
    s * scale[0],
    c * scale[1],
    offset[1],
    0,
  ]);
  if (!values.every(Number.isFinite)) throw new Error('Texture transform exceeds float32 range.');
  return values;
}

/** Preserve the original fixed locations and allocate additional UV sets compactly,
 * even when a model uses sparse semantic numbers such as TEXCOORD_7. */
export function uvLocation(set: number, sets: readonly number[]): number {
  return set === 0 ? 2 : 5 + sets.filter((index) => index !== 0).indexOf(set);
}
