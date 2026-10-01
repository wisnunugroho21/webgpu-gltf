/** Portable decoder capabilities, independent of WebGPU objects. Every selected
 * compressed target preserves RGBA, including alpha and packed material channels. */
export type TextureCompression = 'bc' | 'etc2' | 'astc';
export type ImageFormat = 'rgba8' | 'bc7' | 'etc2' | 'astc';
export interface BasisTarget {
  format: ImageFormat;
  transcoder: number;
  uastcOnly?: boolean;
}
export function basisTargets(support: readonly TextureCompression[]): BasisTarget[] {
  const targets: BasisTarget[] = [];
  // The bundled Basis transcoder supports ASTC for UASTC, not ETC1S. BC7 and
  // ETC2 RGBA work for both encodings. Format IDs belong to the bundled WASM API.
  if (support.includes('astc')) targets.push({ format: 'astc', transcoder: 10, uastcOnly: true });
  if (support.includes('bc')) targets.push({ format: 'bc7', transcoder: 6 });
  if (support.includes('etc2')) targets.push({ format: 'etc2', transcoder: 1 });
  targets.push({ format: 'rgba8', transcoder: 13 });
  return targets;
}

/** All current compressed targets use 16-byte 4x4 blocks. Small mip tails still
 * consume a complete block; uncompressed images retain one RGBA byte tuple per texel. */
export function imageLevelBytes(format: ImageFormat, width: number, height: number): number {
  return format === 'rgba8'
    ? width * height * 4
    : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}
