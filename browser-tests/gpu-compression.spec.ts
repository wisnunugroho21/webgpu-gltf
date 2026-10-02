import { expect, test } from '@playwright/test';

test('Basis targets retain RGBA blocks for both encodings and fall back when unsupported', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { CompressionRuntime } = await import('/src/gltf/compression/runtime.ts');
    const runtime = new CompressionRuntime();
    const images = [];
    try {
      for (const name of ['2d_etc1s.ktx2', '2d_uastc.ktx2']) {
        const bytes = await (await fetch(`/tests/fixtures/compression/${name}`)).arrayBuffer();
        for (const support of [[], ['bc'], ['etc2'], ['astc']] as const) {
          const image = await runtime.basis(bytes.slice(0), support);
          images.push({
            name,
            support: support[0] ?? 'none',
            format: image.format,
            levels: image.levels.length,
            bytes: image.levels.reduce((sum, level) => sum + level.data.length, 0),
            rgbaBytes: image.levels.reduce((sum, level) => sum + level.width * level.height * 4, 0),
            valid: image.levels.every(
              (level) =>
                level.data.length ===
                (image.format === 'rgba8'
                  ? level.width * level.height * 4
                  : Math.ceil(level.width / 4) * Math.ceil(level.height / 4) * 16),
            ),
          });
        }
        if (name.includes('uastc')) {
          // KTX2 levelCount is at byte 40. Existing level offsets remain valid;
          // retain the base payload while exposing only that authored level.
          const single = bytes.slice(0);
          new DataView(single).setUint32(40, 1, true);
          const image = await runtime.basis(single, ['bc']);
          images.push({
            name: 'single-level',
            support: 'bc',
            format: image.format,
            levels: image.levels.length,
            bytes: image.levels[0].data.length,
            rgbaBytes: image.levels[0].width * image.levels[0].height * 4,
            valid:
              image.levels[0].data.length === image.levels[0].width * image.levels[0].height * 4,
          });
        }
      }
      return images;
    } finally {
      runtime.dispose();
    }
  });
  console.log('Basis target measurements:', JSON.stringify(result));
  for (const image of result) {
    const expected =
      image.name === 'single-level' ||
      image.support === 'none' ||
      (image.support === 'astc' && image.name.includes('etc1s'))
        ? 'rgba8'
        : image.support === 'bc'
          ? 'bc7'
          : image.support;
    expect(image.format).toBe(expected);
    expect(image.valid).toBe(true);
    if (image.name === 'single-level') expect(image.levels).toBe(1);
    else expect(image.levels).toBeGreaterThan(1);
    if (expected !== 'rgba8') expect(image.bytes).toBeLessThan(image.rgbaBytes);
  }
});

test('device-backed compressed uploads keep sRGB/data slots and mip tails valid; assets remain portable', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer, loadFiles } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const { prepareTextureCompression, compressionSupport } =
      await import('/src/renderer/textures/compression.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100px;height:100px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = Reflect.get(renderer, 'gpu') as any;
    const device: GPUDevice = internal.device;
    const uploads: { format: GPUTextureFormat; usage: number; mips: number }[] = [];
    const create = device.createTexture.bind(device);
    device.createTexture = (descriptor) => {
      if (descriptor.label?.startsWith('glTF KTX2'))
        uploads.push({
          format: descriptor.format,
          usage: descriptor.usage,
          mips: descriptor.mipLevelCount ?? 1,
        });
      return create(descriptor);
    };
    const results = [];
    try {
      const support = renderer.textureCompression;
      for (const name of ['2d_etc1s.ktx2', '2d_uastc.ktx2']) {
        const template = materialAsset({
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 },
            metallicRoughnessTexture: { index: 0 },
          },
          emissiveTexture: { index: 0 },
          occlusionTexture: { index: 0 },
        });
        const gltf = template.gltf;
        gltf.buffers = template.buffers.map((buffer, i) => ({
          byteLength: buffer.byteLength,
          uri: `mesh${i}.bin`,
        }));
        gltf.images = [{ uri: name, mimeType: 'image/ktx2' }];
        gltf.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
        const bytes = await (await fetch(`/tests/fixtures/compression/${name}`)).arrayBuffer();
        const files = [
          new File([JSON.stringify(gltf)], 'model.gltf'),
          ...template.buffers.map((buffer, i) => new File([buffer], `mesh${i}.bin`)),
          new File([bytes], name),
        ];
        const asset = await loadFiles(files, { textureCompression: support });
        const image = asset.decodedImages!.get(0)!;
        const before = uploads.length;
        await renderer.setAsset(asset);
        device.pushErrorScope('validation');
        renderViewerFrame(renderer, 0);
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope();
        const fallback = await prepareTextureCompression(asset, new Set());
        // Also upload to a feature-free device, proving fallback buffers really are RGBA8.
        const adapter = await navigator.gpu.requestAdapter();
        const baseline = await adapter!.requestDevice();
        const { MaterialFactory, materialLayoutEntries } =
          await import('/src/renderer/materials/factory.ts');
        const { Resources } = await import('/src/renderer/core/resources.ts');
        const { MipmapGenerator } = await import('/src/renderer/textures/mipmaps.ts');
        const resources = new Resources();
        baseline.pushErrorScope('validation');
        try {
          const factory = new MaterialFactory(
            baseline,
            fallback,
            resources,
            baseline.createBindGroupLayout({ entries: materialLayoutEntries }),
            new MipmapGenerator(baseline),
          );
          await factory.get(0);
          await baseline.queue.onSubmittedWorkDone();
          const validation = await baseline.popErrorScope();
          if (validation) errors.push(validation.message);
        } finally {
          resources.destroy();
          baseline.destroy();
        }
        results.push({
          name,
          format: image.format,
          unchanged: asset.decodedImages!.get(0) === image,
          fallback: fallback.decodedImages!.get(0)!.format,
          error: error?.message,
          uploads: uploads.slice(before),
          bytes: image.levels.reduce((sum, level) => sum + level.data.length, 0),
        });
      }
      return { support, enabled: compressionSupport(device.features), results, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  console.log('GPU compression:', JSON.stringify(result));
  expect(result.support).toEqual(result.enabled);
  for (const image of result.results) {
    expect(image.error).toBeUndefined();
    expect(image.unchanged).toBe(true);
    expect(image.fallback).toBe('rgba8');
    expect(image.uploads).toHaveLength(2); // One color allocation and one shared data allocation.
    expect(image.uploads.filter((upload) => upload.format.endsWith('-srgb'))).toHaveLength(1);
    for (const upload of image.uploads) {
      expect(upload.mips).toBeGreaterThan(1);
      expect(upload.usage).toBe(6); // COPY_DST | TEXTURE_BINDING; never RENDER_ATTACHMENT.
      if (image.format !== 'rgba8') expect(upload.format).not.toContain('rgba8unorm');
    }
  }
  expect(result.errors).toEqual([]);
});
