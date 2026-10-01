import { expect, test } from '@playwright/test';

test('GPU environment filtering preserves constant HDR radiance across faces and roughness; BRDF stays finite', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { EnvironmentLighting } = await import('/src/renderer/environment.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const lighting = await EnvironmentLighting.create(device);
    // Read private allocations only in tests: no renderer readback or debug API is needed.
    const allocations = lighting as unknown as {
      maps: { diffuse: GPUTexture; specular: GPUTexture };
      lut: GPUTexture;
    };
    const image = {
      width: 2,
      height: 1,
      pixels: new Float32Array([2, 0.5, 0.25, 1, 2, 0.5, 0.25, 1]),
    };
    await lighting.setImage(image);
    const half = (bits: number) => {
      const exponent = (bits >> 10) & 31,
        fraction = bits & 1023;
      return (
        (bits & 32768 ? -1 : 1) *
        (exponent === 0
          ? (2 ** -14 * fraction) / 1024
          : exponent === 31
            ? Infinity
            : 2 ** (exponent - 15) * (1 + fraction / 1024))
      );
    };
    const read = async (texture: GPUTexture, mip: number, size: number, layers: number) => {
      const row = Math.ceil((size * 8) / 256) * 256;
      const buffer = device.createBuffer({
        size: row * size * layers,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture, mipLevel: mip },
        { buffer, bytesPerRow: row, rowsPerImage: size },
        [size, size, layers],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(buffer.getMappedRange());
      const values: number[] = [];
      for (let layer = 0; layer < layers; layer++)
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++)
            for (let c = 0; c < 4; c++)
              values.push(half(words[((layer * size + y) * row) / 2 + x * 4 + c]));
      buffer.unmap();
      buffer.destroy();
      return values;
    };
    let maxError = 0;
    for (const [texture, levels, size] of [
      [allocations.maps.diffuse, 1, 16],
      [allocations.maps.specular, 7, 64],
    ] as const)
      for (let mip = 0; mip < levels; mip++) {
        const values = await read(texture, mip, size >> mip, 6);
        for (let i = 0; i < values.length; i++)
          maxError = Math.max(maxError, Math.abs(values[i] - [2, 0.5, 0.25, 1][i % 4]));
      }
    const lut = await read(allocations.lut, 0, 64, 1);
    const coefficients = lut.filter((_, i) => i % 4 < 2);
    // A direction-coded panorama catches flipped cube faces and verifies roughness
    // actually broadens reflections rather than merely allocating identical mips.
    const directional = new Float32Array(64 * 32 * 4);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 64; x++) {
        const theta = ((y + 0.5) / 32) * Math.PI,
          phi = ((x + 0.5) / 64 - 0.5) * Math.PI * 2;
        directional.set(
          [
            (Math.sin(theta) * Math.cos(phi) + 1) / 2,
            (Math.cos(theta) + 1) / 2,
            (Math.sin(theta) * Math.sin(phi) + 1) / 2,
            1,
          ],
          (y * 64 + x) * 4,
        );
      }
    await lighting.setImage({ width: 64, height: 32, pixels: directional });
    const sharp = await read(allocations.maps.specular, 0, 64, 6);
    const blurred = await read(allocations.maps.specular, 6, 1, 6);
    const centers = Array.from({ length: 6 }, (_, face) =>
      sharp.slice((face * 64 * 64 + 32 * 64 + 32) * 4, (face * 64 * 64 + 32 * 64 + 32) * 4 + 3),
    );
    let faceError = 0;
    for (let face = 0; face < 6; face++)
      for (let c = 0; c < 3; c++)
        faceError = Math.max(
          faceError,
          Math.abs(centers[face][c] - (c === Math.floor(face / 2) ? (face % 2 ? 0 : 1) : 0.5)),
        );
    const sharpContrast = centers[0][0] - centers[1][0];
    const roughContrast = blurred[0] - blurred[4];
    const previous = lighting.bindGroup;
    let rejected = false;
    try {
      await lighting.setImage({ ...image, pixels: new Float32Array([NaN]) });
    } catch {
      rejected = true;
    }
    const preserved = lighting.bindGroup === previous;
    let invalidSettings = false;
    try {
      lighting.setSettings({ intensity: -1 });
    } catch {
      invalidSettings = true;
    }
    const error = await device.popErrorScope();
    lighting.destroy();
    device.destroy();
    return {
      maxError,
      faceError,
      sharpContrast,
      roughContrast,
      finite: coefficients.every(Number.isFinite),
      min: Math.min(...coefficients),
      max: Math.max(...coefficients),
      rejected,
      preserved,
      invalidSettings,
      error: error?.message,
    };
  });
  expect(result.error).toBeUndefined();
  expect(result.maxError).toBeLessThan(0.005);
  expect(result.faceError).toBeLessThan(0.03);
  expect(result.roughContrast).toBeGreaterThan(0);
  expect(result.roughContrast).toBeLessThan(result.sharpContrast * 0.8);
  expect(result.finite).toBe(true);
  expect(result.min).toBeGreaterThanOrEqual(0);
  expect(result.max).toBeGreaterThan(0.9);
  expect(result.max).toBeLessThan(1.1);
  expect(result.rejected && result.preserved && result.invalidSettings).toBe(true);
});

test('viewer environment intensity, rotation, replacement and studio reset change light without rebuilding geometry', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  const stats = await page.locator('#stats').innerText();
  const before = await page.locator('canvas').screenshot();
  await page.locator('#environment-rotation').evaluate((input) => {
    (input as HTMLInputElement).value = '180';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const rotated = await page.locator('canvas').screenshot();
  expect(rotated.equals(before)).toBe(false);
  await page.locator('#environment-intensity').evaluate((input) => {
    (input as HTMLInputElement).value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect((await page.locator('canvas').screenshot()).equals(rotated)).toBe(false);
  await page.locator('#environment-intensity').evaluate((input) => {
    (input as HTMLInputElement).value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 2;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 4, 2);
    return c.toDataURL().split(',')[1];
  });
  await page.locator('#environment-file').setInputFiles({
    name: 'panorama.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  await expect(page.locator('#environment-name')).toHaveText('panorama.png');
  expect((await page.locator('canvas').screenshot()).equals(rotated)).toBe(false);
  await page
    .locator('#environment-file')
    .setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('invalid') });
  await expect(page.locator('#environment-name')).not.toContainText('Preparing');
  await expect(page.locator('#environment-studio')).toBeEnabled();
  await page.locator('#environment-studio').click();
  await expect(page.locator('#environment-name')).toHaveText('Studio environment');
  expect(
    (await page.locator('canvas').screenshot({ path: 'test-results/environment.png' })).equals(
      rotated,
    ),
  ).toBe(true);
  await expect(page.locator('#stats')).toHaveText(stats);
  expect(errors).toEqual([]);
});

test('PNG environment decoding converts sRGB into linear radiance', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { loadEnvironmentImage } = await import('/src/renderer/environment-source.ts');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray([128, 64, 255, 255]), 1, 1), 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
    return [...(await loadEnvironmentImage(blob)).pixels];
  });
  expect(values[0]).toBeCloseTo(0.21586, 4);
  expect(values[1]).toBeCloseTo(0.05127, 4);
  expect(values.slice(2)).toEqual([1, 1]);
});

test('environment reflects on metals while unlit materials retain their colors', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  for (const kind of ['metal', 'unlit']) {
    const json = await page.evaluate(async (kind) => {
      const { demoAsset } = await import('/src/demo.ts');
      const asset = demoAsset();
      asset.gltf.buffers![0].uri =
        'data:application/octet-stream;base64,' +
        btoa(String.fromCharCode(...new Uint8Array(asset.buffers[0])));
      asset.gltf.materials = asset.gltf.materials!.map(() => ({
        pbrMetallicRoughness: {
          baseColorFactor: [0.6, 0.4, 0.2, 1],
          metallicFactor: 1,
          roughnessFactor: 0.2,
        },
        ...(kind === 'unlit' ? { extensions: { KHR_materials_unlit: {} } } : {}),
      }));
      return JSON.stringify(asset.gltf);
    }, kind);
    await page.locator('#files').setInputFiles({
      name: `${kind}.gltf`,
      mimeType: 'model/gltf+json',
      buffer: Buffer.from(json),
    });
    await expect(page.locator('#status')).toHaveText(`${kind}.gltf`);
    const images: Buffer[] = [];
    for (const intensity of ['1', '0']) {
      await page.locator('#environment-intensity').evaluate((input, value) => {
        (input as HTMLInputElement).value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, intensity);
      images.push(await page.locator('canvas').screenshot());
    }
    expect(images[0].equals(images[1])).toBe(kind !== 'metal');
  }
});
