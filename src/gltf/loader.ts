import type { Asset, DecodedImage, Gltf } from './types';
import { supportedExtensions } from './extensions';
import { decodeDraco, decodeMeshopt } from './compression/geometry';
import { CompressionRuntime } from './compression/runtime';
import type { TextureCompression } from './compression/textures';

export interface LoadOptions {
  /** Defaults to portable RGBA8; pass renderer.textureCompression to avoid a second transcode. */
  textureCompression?: readonly TextureCompression[];
}

type Resolve = (uri: string) => Promise<ArrayBuffer>;
const decoder = new TextDecoder();

/** GLB chunks are little-endian and four-byte padded; their declared lengths are authoritative. */
export function parseGlb(data: ArrayBuffer): { gltf: Gltf; bin?: ArrayBuffer } {
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

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function loadUrl(url: string, options: LoadOptions = {}): Promise<Asset> {
  const absolute = new URL(url, location.href);
  return load(
    await fetchBytes(absolute.href),
    (uri) => fetchBytes(new URL(uri, absolute).href),
    options,
  );
}

export async function loadFiles(files: File[], options: LoadOptions = {}): Promise<Asset> {
  const models = files.filter((file) => /\.(gltf|glb)$/i.test(file.name));
  if (models.length !== 1)
    throw new Error('Select exactly one .gltf or .glb model plus its dependencies.');
  const byName = new Map(files.map((file) => [file.name, file]));
  return load(
    await models[0].arrayBuffer(),
    async (uri) => {
      if (uri.startsWith('data:')) return fetchBytes(uri);
      const name = decodeURIComponent(uri).replace(/\\/g, '/');
      const file = byName.get(name) ?? byName.get(name.split('/').pop()!);
      if (!file) throw new Error(`Missing ${uri}. Select this dependency alongside the model.`);
      return file.arrayBuffer();
    },
    options,
  );
}

async function load(data: ArrayBuffer, resolve: Resolve, options: LoadOptions): Promise<Asset> {
  const { gltf, bin } =
    data.byteLength >= 4 && new DataView(data).getUint32(0, true) === 0x46546c67
      ? parseGlb(data)
      : { gltf: JSON.parse(decoder.decode(data)) as Gltf, bin: undefined };
  if (gltf.asset?.version !== '2.0' || (gltf.asset.minVersion && gltf.asset.minVersion !== '2.0'))
    throw new Error('Only glTF 2.0 is supported.');
  const unsupported = (gltf.extensionsRequired ?? []).filter(
    (name) => !(supportedExtensions as readonly string[]).includes(name),
  );
  if (unsupported.length)
    throw new Error(`Required extensions are unsupported: ${unsupported.join(', ')}`);
  const warnings: string[] = [];
  const buffers = await Promise.all(
    (gltf.buffers ?? []).map(async (buffer, index) => {
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
      if ((buffer.extensions?.EXT_meshopt_compression?.fallback && !buffer.uri) || placeholder)
        return new ArrayBuffer(0);
      const bytes = buffer.uri ? await resolve(buffer.uri) : index === 0 ? bin : undefined;
      if (!bytes || bytes.byteLength < buffer.byteLength)
        throw new Error(`Buffer ${index} is missing or truncated.`);
      return bytes;
    }),
  );
  const runtime = new CompressionRuntime();
  try {
    await decodeMeshopt(gltf, buffers);
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
    await decodeDraco(gltf, buffers, runtime);
    const images = await Promise.all(
      (gltf.images ?? []).map(async (image) => {
        if (image.uri) return new Blob([await resolve(image.uri)]);
        const view = gltf.bufferViews?.[image.bufferView!];
        if (!view) throw new Error('Image has no valid source.');
        return new Blob(
          [
            buffers[view.buffer].slice(
              view.byteOffset ?? 0,
              (view.byteOffset ?? 0) + view.byteLength,
            ),
          ],
          { type: image.mimeType },
        );
      }),
    );
    const decodedImages = new Map<number, DecodedImage>();
    // Decode only KTX2 sources selected by textures; unused fallback images remain blobs.
    for (const texture of gltf.textures ?? []) {
      const source = texture.extensions?.KHR_texture_basisu?.source;
      if (source === undefined) continue;
      if (!images[source]) throw new Error('Basis texture references a missing image.');
      if (!decodedImages.has(source))
        decodedImages.set(
          source,
          await runtime.basis(await images[source].arrayBuffer(), options.textureCompression),
        );
      texture.source = source;
    }
    return { gltf, buffers, images, decodedImages, warnings };
  } finally {
    runtime.dispose();
  }
}
