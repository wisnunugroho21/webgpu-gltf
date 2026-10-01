import { expect, test } from '@playwright/test';

test('area mip filtering retains odd edge impulses and checkerboard energy in every dimension', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MipmapGenerator, mipLevelCount } = await import('/src/renderer/textures/mipmaps.ts');
    const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
    device.pushErrorScope('validation');
    const generator = new MipmapGenerator(device);
    const samples: { name: string; levels: number[][] }[] = [];
    for (const [name, width, height, format] of [
      ['edge', 5, 3, 'rgba8unorm'],
      ['thin-horizontal', 3, 1, 'rgba8unorm'],
      ['thin-vertical', 1, 3, 'rgba8unorm'],
      ['corner', 5, 3, 'rgba8unorm'],
      ['checker', 7, 5, 'rgba8unorm'],
      ['srgb', 3, 1, 'rgba8unorm-srgb'],
    ] as const) {
      const texture = device.createTexture({
        size: [width, height],
        mipLevelCount: mipLevelCount(width, height),
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      });
      try {
        const bytes = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const value =
              name === 'checker'
                ? ((x + y) % 2) * 255
                : name === 'corner'
                  ? x === width - 1 && y === height - 1
                    ? 255
                    : 0
                  : width === 1
                    ? y === height - 1
                      ? 255
                      : 0
                    : x === width - 1
                      ? 255
                      : 0;
            bytes.set([value, 128, 64, 255], (y * width + x) * 4);
          }
        device.queue.writeTexture({ texture }, bytes, { bytesPerRow: width * 4 }, [width, height]);
        await generator.generate(texture);
        const levels: number[][] = [];
        for (let mip = 1; mip < texture.mipLevelCount; mip++) {
          const w = Math.max(1, width >> mip),
            h = Math.max(1, height >> mip);
          const buffer = device.createBuffer({
            size: 256 * h,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture, mipLevel: mip }, { buffer, bytesPerRow: 256 }, [
              w,
              h,
            ]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const read = new Uint8Array(buffer.getMappedRange());
            const packed: number[] = [];
            for (let y = 0; y < h; y++) packed.push(...read.slice(y * 256, y * 256 + w * 4));
            levels.push(packed);
            buffer.unmap();
          } finally {
            buffer.destroy();
          }
        }
        samples.push({ name, levels });
      } finally {
        texture.destroy();
      }
    }
    const error = await device.popErrorScope();
    device.destroy();
    return { samples, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  const levels = (name: string) => result.samples.find((sample) => sample.name === name)!.levels;
  expect(levels('edge')).toEqual([
    [0, 128, 64, 255, 102, 128, 64, 255],
    [51, 128, 64, 255],
  ]);
  for (const name of ['thin-horizontal', 'thin-vertical'])
    expect(levels(name)).toEqual([[85, 128, 64, 255]]);
  expect(levels('corner')).toEqual([
    [0, 128, 64, 255, 34, 128, 64, 255],
    [17, 128, 64, 255],
  ]);
  expect(Math.abs(levels('checker').at(-1)![0] - (255 * 17) / 35)).toBeLessThanOrEqual(2);
  // White occupies exactly one third of the footprint; encode its linear mean.
  const expected = Math.round((1.055 * (1 / 3) ** (1 / 2.4) - 0.055) * 255);
  expect(Math.abs(levels('srgb')[0][0] - expected)).toBeLessThanOrEqual(1);
  expect(levels('srgb')[0].slice(1)).toEqual([128, 64, 255]);
});

test('material image caches separate translucent color mips from opaque/emissive/data and preserve authored levels', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MaterialFactory, materialLayoutEntries } =
      await import('/src/renderer/materials/factory.ts');
    const { MipmapGenerator } = await import('/src/renderer/textures/mipmaps.ts');
    const { Resources } = await import('/src/renderer/core/resources.ts');
    const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
    device.pushErrorScope('validation');
    // Read back actual factory textures, including browser-decoded and KTX2-decoded
    // paths. COPY_SRC is a test-only addition, with no production debug allocation.
    const create = device.createTexture.bind(device);
    device.createTexture = (descriptor) =>
      create({ ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC });
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0]);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), 2, 2), 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    const samples: Record<string, number[]>[] = [];
    const read = async (texture: GPUTexture) => {
      const buffer = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, mipLevel: 1 }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const values = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
        buffer.unmap();
        return values;
      } finally {
        buffer.destroy();
      }
    };
    for (const mode of ['decoded', 'png', 'authored', 'invisible']) {
      const resources = new Resources();
      try {
        const asset: import('../src/gltf/types').Asset = {
          gltf: {
            asset: { version: '2.0' },
            textures: [{ source: 0 }],
            materials: [
              {
                alphaMode: 'BLEND',
                pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
                emissiveTexture: { index: 0 },
                normalTexture: { index: 0 },
              },
              { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
              { alphaMode: 'MASK', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
            ],
          },
          buffers: [],
          images: [blob],
          warnings: [],
        };
        if (mode !== 'png')
          asset.decodedImages = new Map([
            [
              0,
              {
                levels: [
                  {
                    width: 2,
                    height: 2,
                    data:
                      mode === 'invisible'
                        ? new Uint8Array([
                            255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0,
                          ])
                        : data,
                  },
                  ...(mode === 'authored'
                    ? [{ width: 1, height: 1, data: new Uint8Array([9, 99, 199, 17]) }]
                    : []),
                ],
              },
            ],
          ]);
        const factory = new MaterialFactory(
          device,
          asset,
          resources,
          device.createBindGroupLayout({ entries: materialLayoutEntries }),
          new MipmapGenerator(device),
        );
        for (let i = 0; i < 3; i++) await factory.get(i);
        const cache = (factory as unknown as { images: Map<string, Promise<GPUTexture>> }).images;
        const values: Record<string, number[]> = {};
        for (const [key, texture] of cache) values[key] = await read(await texture);
        samples.push(values);
      } finally {
        resources.destroy();
      }
    }
    const error = await device.popErrorScope();
    device.destroy();
    return { samples, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  for (const index of [0, 1, 3]) {
    const values = result.samples[index];
    expect(Object.keys(values).sort()).toEqual([
      '0/rgba8unorm-srgb/alpha-weighted',
      '0/rgba8unorm-srgb/area',
      '0/rgba8unorm/area',
    ]);
  }
  expect(Object.keys(result.samples[2]).sort()).toEqual([
    '0/rgba8unorm-srgb/area',
    '0/rgba8unorm/area',
  ]);
  expect(result.samples[0]['0/rgba8unorm-srgb/alpha-weighted']).toEqual([255, 0, 0, 64]);
  expect(result.samples[0]['0/rgba8unorm-srgb/area']).toEqual([137, 0, 225, 64]);
  expect(result.samples[0]['0/rgba8unorm/area']).toEqual([64, 0, 191, 64]);
  // Canvas exports may zero RGB in alpha-zero pixels; weighted red stays correct.
  expect(result.samples[1]['0/rgba8unorm-srgb/alpha-weighted']).toEqual([255, 0, 0, 64]);
  for (const values of Object.values(result.samples[2])) expect(values).toEqual([9, 99, 199, 17]);
  expect(result.samples[3]['0/rgba8unorm-srgb/alpha-weighted']).toEqual([0, 0, 0, 0]);
  expect(result.samples[3]['0/rgba8unorm-srgb/area']).toEqual([255, 0, 255, 0]);
});
