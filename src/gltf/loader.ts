import type { Asset, DecodedImage, Gltf } from './types';
import { supportedExtensions } from './extensions';
import { decodeDraco, decodeMeshopt } from './compression/geometry';
import { CompressionRuntime } from './compression/runtime';
import type { TextureCompression } from './compression/textures';
import {
  assetLimits,
  AssetBudget,
  AssetValidationError,
  checkLimit,
  type AssetLimits,
} from './limits';
import { fetchAssetBytes, readAssetFile } from './transport';
import { validateMetadata, validatePayload } from './validation';
import { validateImageHeader } from './images';

export interface LoadOptions {
  /** Cancels fetches; decode stages check cancellation before publishing an asset. */
  signal?: AbortSignal;
  /** Per-load CPU policy. Invalid/oversized metadata fails before decoder allocation. */
  limits?: Partial<AssetLimits>;
  /** Defaults to portable RGBA8; pass renderer.textureCompression to avoid a second transcode. */
  textureCompression?: readonly TextureCompression[];
}

type Resolve = (uri: string, path: string) => Promise<ArrayBuffer>;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** GLB chunks are little-endian and four-byte padded; their declared lengths are authoritative. */
export function parseGlb(
  data: ArrayBuffer,
  limits = assetLimits(),
): { gltf: Gltf; bin?: ArrayBuffer } {
  const view = new DataView(data);
  if (
    data.byteLength < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== data.byteLength
  ) {
    throw new Error('Invalid GLB 2.0 header.');
  }
  let gltf: Gltf | undefined;
  let bin: ArrayBuffer | undefined;
  for (let offset = 12; offset < data.byteLength;) {
    if (offset + 8 > data.byteLength) throw new Error('Truncated GLB chunk.');
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > data.byteLength)
      throw new Error('Invalid GLB chunk length.');
    if (type === 0x4e4f534a) checkLimit(length, limits.maxJsonBytes, 'GLB JSON bytes');
    const bytes = data.slice(offset + 8, offset + 8 + length);
    if (offset === 12 && type !== 0x4e4f534a) throw new Error('GLB must start with JSON.');
    if (type === 0x4e4f534a) {
      if (gltf) throw new Error('Duplicate GLB JSON chunk.');
      gltf = JSON.parse(decoder.decode(bytes)) as Gltf;
    } else if (type === 0x004e4942) {
      if (bin) throw new Error('Duplicate GLB binary chunk.');
      bin = bytes;
    }
    offset += 8 + length;
  }
  if (!gltf) throw new Error('GLB has no JSON chunk.');
  return { gltf, bin };
}

export async function loadUrl(url: string, options: LoadOptions = {}): Promise<Asset> {
  const absolute = new URL(url, location.href);
  const budget = new AssetBudget(assetLimits(options.limits), absolute.href);
  return load(
    await fetchAssetBytes(absolute.href, budget, '$', options.signal),
    (uri, path) => fetchAssetBytes(new URL(uri, absolute).href, budget, path, options.signal),
    options,
    budget,
  );
}

export async function loadFiles(files: File[], options: LoadOptions = {}): Promise<Asset> {
  const models = files.filter((file) => /\.(gltf|glb)$/i.test(file.name));
  if (models.length !== 1)
    throw new Error('Select exactly one .gltf or .glb model plus its dependencies.');
  const budget = new AssetBudget(assetLimits(options.limits), models[0].name);
  const byName = new Map(files.map((file) => [file.name, file]));
  return load(
    await readAssetFile(models[0], budget, '$', options.signal),
    async (uri, path) => {
      if (uri.startsWith('data:')) return fetchAssetBytes(uri, budget, path, options.signal);
      const name = decodeURIComponent(uri).replace(/\\/g, '/');
      const file = byName.get(name) ?? byName.get(name.split('/').pop()!);
      if (!file)
        throw new AssetValidationError(
          budget.source,
          path,
          `Missing ${uri}. Select this dependency alongside the model.`,
        );
      return readAssetFile(file, budget, path, options.signal);
    },
    options,
    budget,
  );
}

async function load(
  data: ArrayBuffer,
  resolve: Resolve,
  options: LoadOptions,
  budget: AssetBudget,
): Promise<Asset> {
  options.signal?.throwIfAborted();
  const { gltf, bin } = budget.at('$', () => {
    if (data.byteLength >= 4 && new DataView(data).getUint32(0, true) === 0x46546c67)
      return parseGlb(data, budget.limits);
    checkLimit(data.byteLength, budget.limits.maxJsonBytes, 'JSON bytes');
    return { gltf: JSON.parse(decoder.decode(data)) as unknown, bin: undefined };
  });
  validateMetadata(gltf, budget);
  const unsupported = (gltf.extensionsRequired ?? []).filter(
    (name) => !(supportedExtensions as readonly string[]).includes(name),
  );
  if (unsupported.length)
    throw new AssetValidationError(
      budget.source,
      'extensionsRequired',
      `Required extensions are unsupported: ${unsupported.join(', ')}`,
    );
  const warnings: string[] = [];
  const buffers: ArrayBuffer[] = [];
  for (const [index, buffer] of (gltf.buffers ?? []).entries()) {
    // Required meshopt assets may declare a URI-less fallback buffer as a placeholder.
    // Its compressed views are replaced before any ordinary view is validated.
    const views = (gltf.bufferViews ?? []).filter((view) => view.buffer === index);
    const placeholder =
      !buffer.uri &&
      !(index === 0 && bin) &&
      gltf.extensionsRequired?.includes('EXT_meshopt_compression') &&
      views.length > 0 &&
      views.every((view) => view.extensions?.EXT_meshopt_compression) &&
      !(gltf.bufferViews ?? []).some(
        (view) => view.extensions?.EXT_meshopt_compression?.buffer === index,
      );
    if ((buffer.extensions?.EXT_meshopt_compression?.fallback && !buffer.uri) || placeholder) {
      buffers.push(new ArrayBuffer(0));
      continue;
    }
    const bytes = buffer.uri
      ? await resolve(buffer.uri, `buffers[${index}].uri`)
      : index === 0
        ? bin
        : undefined;
    if (!bytes || bytes.byteLength < buffer.byteLength)
      throw new AssetValidationError(
        budget.source,
        `buffers[${index}]`,
        'Buffer is missing or truncated.',
      );
    budget.decodedBytes(bytes.byteLength, `buffers[${index}]`);
    buffers.push(bytes);
  }
  const runtime = new CompressionRuntime(budget.limits, options.signal);
  try {
    await decodeMeshopt(gltf, buffers, budget, options.signal);
    for (const [index, view] of (gltf.bufferViews ?? []).entries()) {
      if (
        !buffers[view.buffer] ||
        !Number.isSafeInteger(view.byteOffset ?? 0) ||
        !Number.isSafeInteger(view.byteLength) ||
        (view.byteOffset ?? 0) < 0 ||
        view.byteLength < 0 ||
        (view.byteOffset ?? 0) + view.byteLength > buffers[view.buffer].byteLength
      )
        throw new Error(`Invalid bufferView ${index}.`);
    }
    options.signal?.throwIfAborted();
    await decodeDraco(gltf, buffers, runtime, budget, options.signal);
    const images: Blob[] = [];
    for (const [index, image] of (gltf.images ?? []).entries()) {
      options.signal?.throwIfAborted();
      const path = `images[${index}]`;
      const view = gltf.bufferViews?.[image.bufferView!];
      const bytes = image.uri
        ? await resolve(image.uri, `${path}.uri`)
        : buffers[view!.buffer].slice(
            view!.byteOffset ?? 0,
            (view!.byteOffset ?? 0) + view!.byteLength,
          );
      validateImageHeader(bytes, budget, path);
      images.push(new Blob([bytes], { type: image.mimeType }));
    }
    const decodedImages = new Map<number, DecodedImage>();
    // Decode only KTX2 sources selected by textures; unused fallback images remain blobs.
    for (const texture of gltf.textures ?? []) {
      const source = texture.extensions?.KHR_texture_basisu?.source;
      if (source === undefined) continue;
      if (!images[source]) throw new Error('Basis texture references a missing image.');
      if (!decodedImages.has(source))
        decodedImages.set(
          source,
          await runtime
            .basis(await images[source].arrayBuffer(), options.textureCompression)
            .catch((error) => {
              throw new AssetValidationError(
                budget.source,
                `images[${source}]`,
                String(error),
                error,
              );
            }),
        );
      texture.source = source;
    }
    options.signal?.throwIfAborted();
    const asset = { gltf, buffers, images, decodedImages, warnings, limits: budget.limits };
    validatePayload(asset, budget);
    options.signal?.throwIfAborted();
    return asset;
  } catch (error) {
    options.signal?.throwIfAborted();
    return budget.at('$', () => {
      throw error;
    });
  } finally {
    runtime.dispose();
  }
}
