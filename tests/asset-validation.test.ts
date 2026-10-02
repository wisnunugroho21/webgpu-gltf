import { afterEach, expect, test, vi } from 'vitest';
import { loadFiles, loadUrl, parseGlb } from '../src/gltf/loader';
import { assetLimits, AssetBudget } from '../src/gltf/limits';
import { validateMetadata } from '../src/gltf/validation';
import { validateImageHeader } from '../src/gltf/images';
import { fetchAssetBytes } from '../src/gltf/transport';
import { decodeAccessor } from '../src/gltf/accessors';
import { CompressionRuntime } from '../src/gltf/compression/runtime';
import { AssetRegistry } from '../src/engine/assets/registry';
import type { Gltf, Asset } from '../src/gltf/types';
import dracoJson from './fixtures/compression/quad-draco.gltf?raw';
import { loadWorld } from '../src/engine/load-world';
import { World } from '../src/engine/world';

function triangle() {
  const bytes = new ArrayBuffer(42);
  new Float32Array(bytes, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint16Array(bytes, 36, 3).set([0, 1, 2]);
  const gltf: Gltf = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'mesh.bin', byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, type: 'VEC3', componentType: 5126, count: 3 },
      { bufferView: 1, type: 'SCALAR', componentType: 5123, count: 3 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  return { gltf, bytes };
}
function files(gltf: unknown, bytes = triangle().bytes) {
  return [new File([JSON.stringify(gltf)], 'test.gltf'), new File([bytes], 'mesh.bin')];
}
function budget(overrides = {}) {
  return new AssetBudget(assetLimits(overrides), 'test.gltf');
}
afterEach(() => vi.unstubAllGlobals());

test('valid assets retain their resolved policy for subsequent CPU accessor consumers', async () => {
  const { gltf, bytes } = triangle();
  const asset = await loadFiles(files(gltf, bytes), { limits: { maxAccessorValues: 9 } });
  expect(decodeAccessor(asset, asset.gltf.accessors![0])).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  expect(asset.limits?.maxAccessorValues).toBe(9);
  expect(Object.isFrozen(asset.limits)).toBe(true);
});
test.each([
  null,
  [],
  { asset: { version: '2.0' }, nodes: {} },
  { asset: { version: '2.0' }, accessors: [null] },
])('invalid JSON structures fail with source and field context (%j)', async (value) => {
  await expect(loadFiles(files(value))).rejects.toThrow(/Asset test.gltf: (\$|nodes|accessors)/);
});
test('invalid policy fails rather than disabling a bound', () => {
  expect(() => assetLimits({ maxNodes: Infinity })).toThrow('maxNodes');
  expect(() => assetLimits({ maxAccessorValues: 0 })).toThrow('maxAccessorValues');
});
test('local file size is checked before reading its payload', async () => {
  const file = new File([' '.repeat(128)], 'oversized.gltf');
  const read = vi.spyOn(file, 'arrayBuffer');
  await expect(loadFiles([file], { limits: { maxResourceBytes: 64 } })).rejects.toThrow(
    'oversized.gltf',
  );
  expect(read).not.toHaveBeenCalled();
});
test.each([
  [
    'accessor count',
    (g: Gltf) => {
      g.accessors![0].count = 2 ** 40;
    },
  ],
  [
    'offset',
    (g: Gltf) => {
      g.accessors![0].byteOffset = 0.5;
    },
  ],
  [
    'stride',
    (g: Gltf) => {
      g.bufferViews![0].byteStride = 8;
    },
  ],
  [
    'missing index',
    (g: Gltf) => {
      g.meshes![0].primitives[0].indices = 90;
    },
  ],
  [
    'texture reference',
    (g: Gltf) => {
      g.materials = [{ normalTexture: { index: 3 } }];
    },
  ],
  [
    'cycle outside scene',
    (g: Gltf) => {
      g.nodes!.push({ children: [1] });
    },
  ],
  [
    'duplicate parent',
    (g: Gltf) => {
      g.nodes!.push({ children: [0, 0] });
    },
  ],
  [
    'non-finite transform',
    (g: Gltf) => {
      g.nodes![0].translation = [0, 1e309, 0];
    },
  ],
])('rejects %s metadata before dependency reads', async (_name, mutate) => {
  const { gltf, bytes } = triangle();
  mutate(gltf);
  const input = files(gltf, bytes),
    read = vi.spyOn(input[1], 'arrayBuffer');
  await expect(loadFiles(input)).rejects.toThrow('Asset test.gltf:');
  expect(read).not.toHaveBeenCalled();
});
test('node, aggregate accessor and animation expansion limits precede decode allocations', () => {
  const { gltf } = triangle();
  expect(() => validateMetadata({ ...gltf, nodes: [{}, {}] }, budget({ maxNodes: 1 }))).toThrow(
    'nodes',
  );
  expect(() => validateMetadata(gltf, budget({ maxTotalAccessorValues: 11 }))).toThrow(
    'total accessor values',
  );
  const animated = {
    ...gltf,
    accessors: [
      { bufferView: 1, type: 'SCALAR', componentType: 5126, count: 1 },
      { bufferView: 0, type: 'VEC3', componentType: 5126, count: 1 },
    ],
    meshes: undefined,
    nodes: [{}, {}],
    animations: [
      {
        samplers: [{ input: 0, output: 1 }],
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 0, target: { node: 1, path: 'translation' } },
        ],
      },
    ],
  } as Gltf;
  animated.bufferViews![1] = { buffer: 0, byteOffset: 36, byteLength: 4 };
  expect(() => validateMetadata(animated, budget({ maxAnimationKeys: 1 }))).toThrow(
    'animation keys',
  );
  expect(() => validateMetadata(animated, budget({ maxTotalAccessorValues: 8 }))).toThrow(
    'prepared animation values',
  );
});
test('raw non-finite floats and out-of-range indices fail before publishing', async () => {
  const first = triangle();
  new Float32Array(first.bytes, 0, 9)[0] = NaN;
  await expect(loadFiles(files(first.gltf, first.bytes))).rejects.toThrow(
    'accessors[0]: Accessor contains a non-finite',
  );
  const second = triangle();
  new Uint16Array(second.bytes, 36, 3)[0] = 3;
  await expect(loadFiles(files(second.gltf, second.bytes))).rejects.toThrow(
    'Index exceeds vertex count',
  );
});
test('sparse indices are checked before allocating an accessor result', () => {
  const asset: Asset = {
    gltf: {
      asset: { version: '2.0' },
      bufferViews: [
        { buffer: 0, byteLength: 2 },
        { buffer: 0, byteOffset: 4, byteLength: 8 },
      ],
    },
    buffers: [new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer],
    images: [],
    warnings: [],
  };
  expect(() =>
    decodeAccessor(asset, {
      type: 'SCALAR',
      componentType: 5126,
      count: 2,
      sparse: {
        count: 2,
        indices: { bufferView: 0, componentType: 5121 },
        values: { bufferView: 1 },
      },
    }),
  ).toThrow('Sparse indices');
  expect(() =>
    decodeAccessor(asset, { type: 'VEC4', componentType: 5126, count: 2 ** 40 }),
  ).toThrow('limit');
});
test('animation keys are validated at the loader boundary', async () => {
  const bytes = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0]);
  const gltf: Gltf = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'mesh.bin', byteLength: 32 }],
    bufferViews: [{ buffer: 0, byteLength: 32 }],
    accessors: [
      { bufferView: 0, type: 'SCALAR', componentType: 5126, count: 2 },
      { bufferView: 0, byteOffset: 8, type: 'VEC3', componentType: 5126, count: 2 },
    ],
    nodes: [{}],
    animations: [
      {
        samplers: [{ input: 0, output: 1 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      },
    ],
  };
  await expect(loadFiles(files(gltf, bytes.buffer))).rejects.toThrow(
    'animations[0]: Animation key times',
  );
});
test('zero quaternion animation keys cannot publish an asset that fails on first playback', async () => {
  const bytes = new Float32Array([0, 0, 0, 0, 0]);
  const gltf: Gltf = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'mesh.bin', byteLength: 20 }],
    bufferViews: [{ buffer: 0, byteLength: 20 }],
    accessors: [
      { bufferView: 0, type: 'SCALAR', componentType: 5126, count: 1 },
      { bufferView: 0, byteOffset: 4, type: 'VEC4', componentType: 5126, count: 1 },
    ],
    nodes: [{}],
    animations: [
      {
        samplers: [{ input: 0, output: 1 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      },
    ],
  };
  await expect(loadFiles(files(gltf, bytes.buffer))).rejects.toThrow(
    'rotation key has zero length',
  );
});
function png(width: number, height: number) {
  const bytes = new ArrayBuffer(33),
    view = new DataView(bytes);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, width, height].forEach((value, i) =>
    view.setUint32(i * 4, value),
  );
  return bytes;
}
test('image headers bound per-image and aggregate decoded pixels before bitmap creation', () => {
  expect(() =>
    validateImageHeader(png(32, 32), budget({ maxImageDimension: 16 }), 'images[0]'),
  ).toThrow('image width');
  expect(() =>
    validateImageHeader(png(16, 16), budget({ maxImagePixels: 128 }), 'images[0]'),
  ).toThrow('image pixels');
  const load = budget({ maxTotalImagePixels: 300 });
  validateImageHeader(png(16, 16), load, 'images[0]');
  expect(() => validateImageHeader(png(16, 16), load, 'images[1]')).toThrow('images[1]');
  expect(() => validateImageHeader(new ArrayBuffer(3), budget(), 'images[0]')).toThrow(
    'Unsupported image header',
  );
});
test('KTX2 dimensions and mip ranges are bounded before worker transcode', () => {
  const bytes = new ArrayBuffer(108),
    view = new DataView(bytes);
  new Uint8Array(bytes).set([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  view.setUint32(20, 4, true);
  view.setUint32(24, 4, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setBigUint64(80, 104n, true);
  view.setBigUint64(88, 4n, true);
  validateImageHeader(bytes, budget(), 'images[0]');
  new DataView(bytes).setUint32(40, 100, true);
  expect(() => validateImageHeader(bytes, budget(), 'images[0]')).toThrow('mip count');
});
test('oversized compressed declarations fail before loading decoder WASM', async () => {
  const gltf = JSON.parse(dracoJson) as Gltf;
  gltf.accessors![0].count = 2 ** 40;
  await expect(loadFiles(files(gltf))).rejects.toThrow('accessors[0]');
  const meshopt: Gltf = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4, uri: 'missing.bin' }],
    bufferViews: [
      {
        buffer: 0,
        byteLength: 2 ** 40,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteLength: 4,
            byteStride: 4,
            count: 2 ** 38,
            mode: 'ATTRIBUTES',
          },
        },
      },
    ],
  };
  await expect(loadFiles(files(meshopt))).rejects.toThrow('bufferView 0');
});
test.each([undefined, '1'])(
  'stream limits enforce actual bytes when Content-Length is %s',
  async (hint) => {
    let canceled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(4));
              },
              cancel() {
                canceled = true;
              },
            }),
            { headers: hint ? { 'content-length': hint } : {} },
          ),
      ),
    );
    await expect(
      fetchAssetBytes('https://example.test/model', budget({ maxResourceBytes: 6 }), 'buffers[0]'),
    ).rejects.toThrow('resource bytes');
    expect(canceled).toBe(true);
  },
);
test('a large Content-Length cancels the unread response body', async () => {
  let canceled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { headers: { 'content-length': '99' } },
        ),
    ),
  );
  await expect(
    fetchAssetBytes('https://example.test/model', budget({ maxResourceBytes: 6 }), '$'),
  ).rejects.toThrow('Content-Length');
  expect(canceled).toBe(true);
});
test('aggregate bytes include dependency reads and fail with source URI and path', async () => {
  vi.stubGlobal('location', { href: 'https://example.test/' });
  const { gltf } = triangle(),
    text = JSON.stringify(gltf),
    max = new TextEncoder().encode(text).length + 10;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(url.endsWith('.gltf') ? text : triangle().bytes)),
  );
  await expect(loadUrl('model.gltf', { limits: { maxTotalBytes: max } })).rejects.toThrow(
    'Asset https://example.test/model.gltf: buffers[0].uri: total transport bytes',
  );
});
test('abort terminates a compression worker and rejects its pending request promptly', async () => {
  const terminated = vi.fn();
  vi.stubGlobal('location', { href: 'https://example.test/' });
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: unknown;
      onerror?: unknown;
      terminate = terminated;
      postMessage() {}
    },
  );
  const controller = new AbortController(),
    runtime = new CompressionRuntime(assetLimits(), controller.signal);
  const request = runtime.basis(new ArrayBuffer(80));
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(terminated).toHaveBeenCalledOnce();
  runtime.dispose();
});
test('a failed validated registry load does not replace cached resources and can retry', async () => {
  let corrupt = true;
  const registry = new AssetRegistry({
    resolve: async () => {
      const { gltf, bytes } = triangle();
      if (corrupt) new Uint16Array(bytes, 36, 3)[0] = 99;
      return loadFiles(files(gltf, bytes));
    },
  });
  registry.declare('model', 'model.gltf');
  await expect(registry.load('model')).rejects.toThrow('assets["model"]');
  expect(registry.inspect('model').status).toBe('failed');
  expect(() => registry.get('model')).toThrow('not loaded');
  corrupt = false;
  expect((await registry.load('model')).asset.buffers).toHaveLength(1);
  expect(registry.inspect('model').status).toBe('ready');
  registry.destroy();
});

test('GLB JSON chunk limits apply before text parsing', () => {
  const bytes = new ArrayBuffer(84),
    view = new DataView(bytes);
  [0x46546c67, 2, 84, 64, 0x4e4f534a].forEach((value, i) => view.setUint32(i * 4, value, true));
  expect(() => parseGlb(bytes, assetLimits({ maxJsonBytes: 32 }))).toThrow('GLB JSON bytes');
});

test('JPEG segment dimensions are bounded and truncated markers fail contextually', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 8, 0, 16, 1]).buffer;
  validateImageHeader(bytes, budget(), 'images[0]');
  expect(() => validateImageHeader(bytes, budget({ maxImageDimension: 8 }), 'images[0]')).toThrow(
    'image width',
  );
  expect(() => validateImageHeader(bytes.slice(0, 6), budget(), 'images[0]')).toThrow(
    'segment length',
  );
});
test('invalid CPU decoding cannot publish a replacement world or change the existing model', async () => {
  const { gltf, bytes } = triangle();
  const good = await loadFiles(files(gltf, bytes));
  const registry = new AssetRegistry({
    resolve: async () => {
      const bad = triangle();
      new Float32Array(bad.bytes, 0, 9)[0] = NaN;
      return loadFiles(files(bad.gltf, bad.bytes));
    },
  });
  registry.register('good', good, 'good.gltf');
  const initial = World.fromDocument(
    {
      version: 1,
      assets: { good: 'good.gltf' },
      entities: [{ id: 'hero', model: { asset: 'good' } }],
    },
    registry,
  );
  const hero = initial.getEntity('hero'),
    model = hero.model;
  await expect(
    loadWorld(
      {
        version: 1,
        assets: { bad: 'bad.gltf' },
        entities: [{ id: 'replacement', model: { asset: 'bad' } }],
      },
      undefined,
      { assets: registry },
    ),
  ).rejects.toThrow('accessors[0]');
  expect(initial.entities).toEqual([hero]);
  expect(initial.getEntity('hero').model).toBe(model);
  expect(registry.get('good')).toBe(good);
  expect(registry.inspect('bad').status).toBe('failed');
  registry.destroy();
});
test('negative skin weights fail at the asset boundary rather than first deformation', async () => {
  const { gltf } = triangle();
  const bytes = new ArrayBuffer(108);
  new Uint8Array(bytes).set(new Uint8Array(triangle().bytes));
  gltf.buffers![0].byteLength = 108;
  gltf.bufferViews!.push(
    { buffer: 0, byteOffset: 48, byteLength: 12 },
    { buffer: 0, byteOffset: 60, byteLength: 48 },
  );
  gltf.accessors!.push(
    { bufferView: 2, type: 'VEC4', componentType: 5121, count: 3 },
    { bufferView: 3, type: 'VEC4', componentType: 5126, count: 3 },
  );
  Object.assign(gltf.meshes![0].primitives[0].attributes, { JOINTS_0: 2, WEIGHTS_0: 3 });
  gltf.skins = [{ joints: [1] }];
  gltf.nodes!.push({});
  gltf.nodes![0].skin = 0;
  new Float32Array(bytes, 60, 12).set([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  await expect(loadFiles(files(gltf, bytes))).rejects.toThrow('Negative skin weight');
});

test('shared accessor references and omitted morph weights cannot expand unbounded CPU arrays', () => {
  const { gltf } = triangle();
  gltf.meshes![0].primitives[0].targets = [{ POSITION: 0 }, { POSITION: 0 }];
  gltf.nodes = [{ mesh: 0 }, { mesh: 0 }];
  gltf.scenes = undefined;
  expect(() => validateMetadata(gltf, budget({ maxPoseValues: 23 }))).toThrow(
    'pose TRS/morph values',
  );
  gltf.nodes = [{ mesh: 0 }];
  expect(() => validateMetadata(gltf, budget({ maxTotalAccessorValues: 20 }))).toThrow(
    'expanded geometry values',
  );
});
