/** CPU limits are application policy, independent of GPU limits. Counts bound JSON
 * metadata and decoded work; byte budgets are per load, not process memory meters. */
export interface AssetLimits {
  maxResourceBytes: number;
  maxTotalBytes: number;
  maxJsonBytes: number;
  maxDecodedBufferBytes: number;
  maxAccessorValues: number;
  maxTotalAccessorValues: number;
  maxNodes: number;
  maxPoseValues: number;
  maxDefinitions: number;
  maxAnimationChannels: number;
  maxAnimationKeys: number;
  maxImageDimension: number;
  maxImagePixels: number;
  maxTotalImagePixels: number;
}
const MiB = 1024 * 1024;
export const defaultAssetLimits: Readonly<AssetLimits> = Object.freeze({
  maxResourceBytes: 256 * MiB,
  maxTotalBytes: 512 * MiB,
  maxJsonBytes: 16 * MiB,
  maxDecodedBufferBytes: 512 * MiB,
  maxAccessorValues: 16 * MiB,
  maxTotalAccessorValues: 64 * MiB,
  maxNodes: 100_000,
  maxPoseValues: 4 * MiB,
  maxDefinitions: 100_000,
  maxAnimationChannels: 100_000,
  maxAnimationKeys: 4 * MiB,
  maxImageDimension: 16_384,
  maxImagePixels: 64 * MiB,
  maxTotalImagePixels: 128 * MiB,
});
export class AssetValidationError extends Error {
  constructor(
    readonly source: string,
    readonly path: string,
    detail: string,
    cause?: unknown,
  ) {
    super(`Asset ${source}: ${path}: ${detail}`, { cause });
    this.name = 'AssetValidationError';
  }
}
export function assetLimits(overrides: Partial<AssetLimits> = {}): Readonly<AssetLimits> {
  const result = { ...defaultAssetLimits, ...overrides };
  for (const [key, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid asset limit ${key}.`);
  return Object.freeze(result);
}
export function checkLimit(value: number, maximum: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`${path} exceeds limit ${maximum} (received ${value}).`);
}
/** Reserve before allocating. Separate counters keep transport, decoded geometry,
 * and image estimates understandable without claiming exact browser/WASM memory. */
export class AssetBudget {
  private transport = 0;
  private decoded = 0;
  private pixels = 0;
  constructor(
    readonly limits: Readonly<AssetLimits>,
    readonly source: string,
  ) {}
  at<T>(path: string, action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof AssetValidationError) throw error;
      throw new AssetValidationError(
        this.source,
        path,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
  bytes(bytes: number, path: string): void {
    this.at(path, () => {
      checkLimit(bytes, this.limits.maxResourceBytes, 'resource bytes');
      checkLimit(this.transport + bytes, this.limits.maxTotalBytes, 'total transport bytes');
      this.transport += bytes;
    });
  }
  get remainingDecodedBytes(): number {
    return this.limits.maxDecodedBufferBytes - this.decoded;
  }
  decodedBytes(bytes: number, path: string): void {
    this.at(path, () => {
      checkLimit(this.decoded + bytes, this.limits.maxDecodedBufferBytes, 'decoded buffer bytes');
      this.decoded += bytes;
    });
  }
  image(width: number, height: number, path: string): void {
    this.at(path, () => {
      if (width < 1 || height < 1) throw new Error('Invalid image dimensions.');
      checkLimit(width, this.limits.maxImageDimension, 'image width');
      checkLimit(height, this.limits.maxImageDimension, 'image height');
      checkLimit(width * height, this.limits.maxImagePixels, 'image pixels');
      checkLimit(
        this.pixels + width * height,
        this.limits.maxTotalImagePixels,
        'total image pixels',
      );
      this.pixels += width * height;
    });
  }
}
