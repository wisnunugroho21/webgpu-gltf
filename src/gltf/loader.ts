import type { Asset, Gltf } from './types';

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

export async function loadUrl(url: string): Promise<Asset> {
  const absolute = new URL(url, location.href);
  return load(await fetchBytes(absolute.href), (uri) => fetchBytes(new URL(uri, absolute).href));
}

export async function loadFiles(files: File[]): Promise<Asset> {
  const models = files.filter((file) => /\.(gltf|glb)$/i.test(file.name));
  if (models.length !== 1)
    throw new Error('Select exactly one .gltf or .glb model plus its dependencies.');
  const byName = new Map(files.map((file) => [file.name, file]));
  return load(await models[0].arrayBuffer(), async (uri) => {
    if (uri.startsWith('data:')) return fetchBytes(uri);
    const name = decodeURIComponent(uri).replace(/\\/g, '/');
    const file = byName.get(name) ?? byName.get(name.split('/').pop()!);
    if (!file) throw new Error(`Missing ${uri}. Select this dependency alongside the model.`);
    return file.arrayBuffer();
  });
}

async function load(data: ArrayBuffer, resolve: Resolve): Promise<Asset> {
  const { gltf, bin } =
    data.byteLength >= 4 && new DataView(data).getUint32(0, true) === 0x46546c67
      ? parseGlb(data)
      : { gltf: JSON.parse(decoder.decode(data)) as Gltf, bin: undefined };
  if (gltf.asset?.version !== '2.0' || (gltf.asset.minVersion && gltf.asset.minVersion !== '2.0'))
    throw new Error('Only glTF 2.0 is supported.');
  const unsupported = (gltf.extensionsRequired ?? []).filter(
    (name) => name !== 'KHR_materials_unlit',
  );
  if (unsupported.length)
    throw new Error(`Required extensions are unsupported: ${unsupported.join(', ')}`);
  if (
    gltf.nodes?.some((node) => node.skin !== undefined) ||
    gltf.meshes?.some((mesh) => mesh.primitives.some((p) => p.targets?.length))
  ) {
    throw new Error('Skinned meshes and morph targets are not supported.');
  }
  const warnings: string[] = [];
  if (gltf.animations?.length)
    warnings.push('Animations are ignored; the authored static pose is shown.');
  const buffers = await Promise.all(
    (gltf.buffers ?? []).map(async (buffer, index) => {
      const bytes = buffer.uri ? await resolve(buffer.uri) : index === 0 ? bin : undefined;
      if (!bytes || bytes.byteLength < buffer.byteLength)
        throw new Error(`Buffer ${index} is missing or truncated.`);
      return bytes;
    }),
  );
  for (const [index, view] of (gltf.bufferViews ?? []).entries()) {
    if (
      !buffers[view.buffer] ||
      (view.byteOffset ?? 0) < 0 ||
      view.byteLength < 0 ||
      (view.byteOffset ?? 0) + view.byteLength > buffers[view.buffer].byteLength
    )
      throw new Error(`Invalid bufferView ${index}.`);
  }
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
  return { gltf, buffers, images, warnings };
}
