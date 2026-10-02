import { expect, test, type Page } from '@playwright/test';

// Examine the presented canvas rather than just successful loading or shader compilation.
// The white-emission bug can pass those checks while hiding all base-color details.
async function colorfulPixels(page: Page, screenshot: Buffer): Promise<number> {
  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colorful = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (max > 60 && max - min > 30) colorful++;
    }
    return colorful;
  }, screenshot.toString('base64'));
}

test('a black emissive map masks a white emissive factor without washing out base color', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  const json = await page.evaluate(async () => {
    const { demoAsset } = await import('/src/app/demo.ts');
    const asset = demoAsset();
    const gltf = asset.gltf;
    const dataUri = (bytes: Uint8Array) =>
      'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes));
    gltf.buffers[0].uri = dataUri(new Uint8Array(asset.buffers[0]));
    const uv = new Float32Array(48);
    gltf.buffers.push({ uri: dataUri(new Uint8Array(uv.buffer)), byteLength: uv.byteLength });
    gltf.bufferViews.push({ buffer: 1, byteLength: uv.byteLength });
    gltf.accessors.push({ bufferView: 2, type: 'VEC2', componentType: 5126, count: 24 });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, 1, 1);
    gltf.images = [{ uri: canvas.toDataURL('image/png') }];
    gltf.textures = [{ source: 0 }];
    gltf.materials.forEach((material) => {
      material.emissiveFactor = [1, 1, 1];
      material.emissiveTexture = { index: 0 };
    });
    gltf.meshes.forEach((mesh) => {
      mesh.primitives[0].attributes.TEXCOORD_0 = 3;
    });
    return JSON.stringify(gltf);
  });
  await page.route('**/emissive.gltf', (route) =>
    route.fulfill({ contentType: 'model/gltf+json', body: json }),
  );
  await page.locator('#url').fill('http://127.0.0.1:5173/emissive.gltf');
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('emissive.gltf');
  const screenshot = await page.locator('canvas').screenshot({ path: 'test-results/emissive.png' });
  expect(await colorfulPixels(page, screenshot)).toBeGreaterThan(2000);
  await expect(page.locator('#warnings')).not.toContainText('emissive');

  // Removing the map must restore factor-only emission via the neutral white fallback.
  // This also prevents an apparent fix that simply disables all emissive contributions.
  const factorOnly = JSON.parse(json);
  factorOnly.materials.forEach((material: { emissiveTexture?: unknown }) => {
    delete material.emissiveTexture;
  });
  await page.route('**/factor-only.gltf', (route) =>
    route.fulfill({ contentType: 'model/gltf+json', body: JSON.stringify(factorOnly) }),
  );
  await page.locator('#url').fill('http://127.0.0.1:5173/factor-only.gltf');
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('factor-only.gltf');
  expect(await colorfulPixels(page, await page.locator('canvas').screenshot())).toBe(0);
});

test('Khronos DamagedHelmet GLB retains visible texture colors', async ({ page }) => {
  test.skip(
    !process.env.TEST_REMOTE_MODELS,
    'Opt-in network test against the user-reported asset.',
  );
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  await page
    .locator('#url')
    .fill(
      'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/refs/heads/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb',
    );
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('DamagedHelmet.glb', { timeout: 60_000 });
  await expect(page.locator('#warnings')).toBeEmpty();
  const screenshot = await page
    .locator('canvas')
    .screenshot({ path: 'test-results/damaged-helmet.png' });
  expect(await colorfulPixels(page, screenshot)).toBeGreaterThan(500);
});

test('offline demo compiles, instances, resizes, and responds to orbit controls', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#stats')).toHaveText('1 pipelines · 2 draws · 4 primitive instances');
  await expect(page.locator('#status')).toHaveText('Built-in instancing scene');
  const canvas = page.locator('canvas');
  await canvas.screenshot({ path: 'test-results/demo.png' });
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(650, 440);
  await page.mouse.up();
  await page.mouse.wheel(0, 200);
  await page.setViewportSize({ width: 650, height: 780 });
  await page.locator('#reset').click();
  await canvas.screenshot({ path: 'test-results/demo-resized.png' });
  expect(errors).toEqual([]);
  await expect(page.locator('#status')).toHaveText('Built-in instancing scene');
});

test('textured glTF exercises missing attributes, mask/blend, colors, mirroring and samplers', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  const json = await page.evaluate(async () => {
    // Vite serves the real preparation input; no renderer internals are mocked.
    const { demoAsset } = await import('/src/app/demo.ts');
    const asset = demoAsset();
    const gltf = asset.gltf;
    const dataUri = (bytes: Uint8Array) =>
      'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes));
    gltf.buffers[0].uri = dataUri(new Uint8Array(asset.buffers[0]));
    // UV/color use integer formats, exercising the repack path and shader color input.
    const uv = new Uint16Array(48);
    for (let i = 0; i < 24; i++) {
      uv[i * 2] = i % 4 === 1 || i % 4 === 2 ? 65535 : 0;
      uv[i * 2 + 1] = i % 4 >= 2 ? 65535 : 0;
    }
    const colors = new Uint8Array(96).fill(255);
    gltf.buffers.push(
      { uri: dataUri(new Uint8Array(uv.buffer)), byteLength: uv.byteLength },
      { uri: dataUri(colors), byteLength: colors.byteLength },
    );
    gltf.bufferViews.push(
      { buffer: 1, byteLength: uv.byteLength },
      { buffer: 2, byteLength: colors.byteLength },
    );
    gltf.accessors.push(
      { bufferView: 2, type: 'VEC2', componentType: 5123, normalized: true, count: 24 },
      { bufferView: 3, type: 'VEC4', componentType: 5121, normalized: true, count: 24 },
    );
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 4, 4);
    ctx.fillStyle = '#3060ff';
    ctx.fillRect(0, 0, 2, 2);
    ctx.clearRect(2, 2, 2, 2);
    gltf.images = [{ uri: canvas.toDataURL('image/png') }];
    gltf.samplers = [{ wrapS: 33648, wrapT: 33071, magFilter: 9728, minFilter: 9984 }];
    gltf.textures = [{ source: 0, sampler: 0 }];
    gltf.materials = ['OPAQUE', 'MASK', 'BLEND'].map((alphaMode) => ({
      alphaMode,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, alphaMode === 'BLEND' ? 0.5 : 1],
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 0.8,
      },
    }));
    gltf.meshes = [0, 1, 2].map((material) => ({
      primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 3, COLOR_0: 4 }, indices: 2, material },
      ],
    }));
    gltf.nodes = [
      { mesh: 0, translation: [-2.5, 0, 0] },
      { mesh: 1 },
      { mesh: 2, translation: [2.5, 0, 0], scale: [-1, 1, 1] },
    ];
    gltf.scenes = [{ nodes: [0, 1, 2] }];
    return JSON.stringify(gltf);
  });
  await page.route('**/fixture.gltf', (route) =>
    route.fulfill({ contentType: 'model/gltf+json', body: json }),
  );
  await page.locator('#url').fill('http://127.0.0.1:5173/fixture.gltf');
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('fixture.gltf');
  await expect(page.locator('#stats')).toContainText('3 draws · 3 primitive instances');
  await page.locator('canvas').screenshot({ path: 'test-results/textured.png' });
  expect(errors).toEqual([]);
});

test('invalid and relative model URLs use the recoverable viewer loading path', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  const original = await page.locator('#stats').textContent();
  await page.locator('#url').fill('http://[');
  // Native URL input validation can prevent the submit event; explicitly exercise
  // the listener to verify its own error boundary as well.
  await page
    .locator('#url-form')
    .evaluate((form) =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  await expect(page.locator('#status')).toContainText('Invalid URL');
  await expect(page.locator('#stats')).toHaveText(original!);
  await expect(page.locator('#url-form button')).toBeEnabled();
  await page.route('**/relative.gltf', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        asset: { version: '2.0' },
        extensionsRequired: ['TEST_unsupported_extension'],
      }),
    }),
  );
  await page.locator('#url').fill('relative.gltf');
  await page
    .locator('#url-form')
    .evaluate((form) =>
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  await expect(page.locator('#status')).toContainText('Required extensions are unsupported');
  await expect(page.locator('#stats')).toHaveText(original!);
  expect(errors).toEqual([]);
});

test('local GLB loads and a rejected replacement keeps the current scene', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  const bytes = await page.evaluate(async () => {
    const { demoAsset } = await import('/src/app/demo.ts');
    const asset = demoAsset();
    const encoded = new TextEncoder().encode(JSON.stringify(asset.gltf));
    const length = Math.ceil(encoded.length / 4) * 4;
    const bin = asset.buffers[0];
    const result = new ArrayBuffer(28 + length + bin.byteLength);
    const view = new DataView(result);
    [0x46546c67, 2, result.byteLength, length, 0x4e4f534a].forEach((value, i) =>
      view.setUint32(i * 4, value, true),
    );
    new Uint8Array(result, 20, length).fill(32);
    new Uint8Array(result, 20).set(encoded);
    view.setUint32(20 + length, bin.byteLength, true);
    view.setUint32(24 + length, 0x004e4942, true);
    new Uint8Array(result, 28 + length).set(new Uint8Array(bin));
    return [...new Uint8Array(result)];
  });
  await page
    .locator('#files')
    .setInputFiles({ name: 'demo.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(bytes) });
  await expect(page.locator('#status')).toHaveText('demo.glb');
  await page.route('**/bad.gltf', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        asset: { version: '2.0' },
        extensionsRequired: ['TEST_unsupported_extension'],
      }),
    }),
  );
  await page.locator('#url').fill('http://127.0.0.1:5173/bad.gltf');
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toContainText('Required extensions are unsupported');
  await expect(page.locator('#stats')).toHaveText('1 pipelines · 2 draws · 4 primitive instances');
  await page.locator('#demo').click();
  await expect(page.locator('#status')).toHaveText('Built-in instancing scene');
});
