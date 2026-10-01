import { expect, test } from '@playwright/test';

test('anisotropic sampler policy passes real WebGPU validation for all glTF filter modes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { samplerDescriptor } = await import('/src/renderer/textures/samplers.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    let enabled = 0;
    for (const minFilter of [9728, 9729, 9984, 9985, 9986, 9987])
      for (const magFilter of [9728, 9729]) {
        const descriptor = samplerDescriptor({ minFilter, magFilter });
        device.createSampler(descriptor);
        if (descriptor.maxAnisotropy! > 1) enabled++;
      }
    device.createSampler(samplerDescriptor());
    device.createSampler(samplerDescriptor({}, 1));
    const error = await device.popErrorScope();
    device.destroy();
    return { enabled, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  expect(result.enabled).toBe(1); // only LINEAR_MIPMAP_LINEAR + LINEAR magnification
});

test('GPU mipmaps filter color in linear light, preserve data values and handle NPOT/thin images', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MipmapGenerator, mipLevelCount } = await import('/src/renderer/textures/mipmaps.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const generator = new MipmapGenerator(device);
    const samples: number[][] = [];
    for (const [width, height, format] of [
      [2, 2, 'rgba8unorm-srgb'],
      [2, 2, 'rgba8unorm'],
      [5, 3, 'rgba8unorm'],
      [1, 8, 'rgba8unorm'],
    ] as const) {
      const levels = mipLevelCount(width, height);
      const texture = device.createTexture({
        size: [width, height],
        mipLevelCount: levels,
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      });
      const bytes = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++)
        bytes.set(
          width === 2
            ? [i % 2 ? 255 : 0, i % 2 ? 255 : 0, i % 2 ? 255 : 0, 128]
            : [64, 128, 192, 255],
          i * 4,
        );
      const readback = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      try {
        device.queue.writeTexture({ texture }, bytes, { bytesPerRow: width * 4 }, [width, height]);
        await generator.generate(texture);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture, mipLevel: levels - 1 },
          { buffer: readback, bytesPerRow: 256 },
          [1, 1],
        );
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        samples.push([...new Uint8Array(readback.getMappedRange()).slice(0, 4)]);
        readback.unmap();
      } finally {
        texture.destroy();
        readback.destroy();
      }
    }
    const error = await device.popErrorScope();
    device.destroy();
    return { samples, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  expect(Math.abs(result.samples[0][0] - 188)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.samples[1][0] - 128)).toBeLessThanOrEqual(1);
  expect(result.samples[0][3]).toBe(128);
  expect(result.samples[1][3]).toBe(128);
  expect(result.samples[2]).toEqual([64, 128, 192, 255]);
  expect(result.samples[3]).toEqual([64, 128, 192, 255]);
});

test('Khronos ChronographWatch loads with texture transforms', async ({ page }) => {
  test.skip(!process.env.TEST_REMOTE_MODELS, 'Optional public asset regression.');
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  await page
    .locator('#url')
    .fill(
      'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ChronographWatch/glTF-Binary/ChronographWatch.glb',
    );
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('ChronographWatch.glb', { timeout: 100_000 });
  await page.locator('canvas').screenshot({ path: 'test-results/ChronographWatch.png' });
  expect(errors).toEqual([]);
});
