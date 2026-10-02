import type { Asset } from '../../gltf/types';
import { CompressionRuntime } from '../../gltf/compression/runtime';
import type { ImageFormat, TextureCompression } from '../../gltf/compression/textures';

const compressionFeatures = [
  ['bc', 'texture-compression-bc'],
  ['etc2', 'texture-compression-etc2'],
  ['astc', 'texture-compression-astc'],
] as const;
export function compressionRequirements(features: ReadonlySet<string>): GPUFeatureName[] {
  return compressionFeatures
    .filter(([, feature]) => features.has(feature))
    .map(([, feature]) => feature);
}
export function compressionSupport(features: ReadonlySet<string>): TextureCompression[] {
  return compressionFeatures
    .filter(([, feature]) => features.has(feature))
    .map(([family]) => family);
}
export function compressedFormat(format: ImageFormat, srgb: boolean): GPUTextureFormat {
  const base = {
    rgba8: 'rgba8unorm',
    bc7: 'bc7-rgba-unorm',
    etc2: 'etc2-rgba8unorm',
    astc: 'astc-4x4-unorm',
  }[format];
  return `${base}${srgb ? '-srgb' : ''}` as GPUTextureFormat;
}

/** Adapt portable assets or assets decoded for another device without mutating them.
 * One temporary worker handles all selected Basis images and always terminates.
 * Plain loader calls stay compatible; supplying loader capabilities avoids RGBA first. */
export async function prepareTextureCompression(
  asset: Asset,
  features: ReadonlySet<string>,
): Promise<Asset> {
  const support = compressionSupport(features);
  const sources = new Set(
    (asset.gltf.textures ?? []).flatMap((texture) => {
      const source = texture.extensions?.KHR_texture_basisu?.source;
      // Consumers may replace a decoded source with a PNG/JPEG while retaining
      // glTF metadata. Only re-transcode known Basis sources, never arbitrary blobs.
      return source === undefined ||
        (!asset.decodedImages?.has(source) && asset.images[source]?.type !== 'image/ktx2')
        ? []
        : [source];
    }),
  );
  if (!sources.size) return asset;
  const decodedImages = new Map(asset.decodedImages);
  const runtime = new CompressionRuntime(asset.limits);
  try {
    for (const source of sources) {
      const decoded = decodedImages.get(source);
      const format = decoded?.format ?? 'rgba8';
      const family = format === 'bc7' ? 'bc' : format;
      const sameCapabilities =
        decoded?.transcodedFor?.length === support.length &&
        support.every((family) => decoded!.transcodedFor!.includes(family));
      if (
        decoded &&
        ((format === 'rgba8' && (!support.length || sameCapabilities)) ||
          (format !== 'rgba8' && support.includes(family as TextureCompression)))
      )
        continue;
      const blob = asset.images[source];
      if (!blob) throw new Error('Basis texture references a missing image.');
      decodedImages.set(source, await runtime.basis(await blob.arrayBuffer(), support));
    }
    return { ...asset, decodedImages };
  } finally {
    runtime.dispose();
  }
}
