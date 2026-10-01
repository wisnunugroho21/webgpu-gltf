import { expect, test, type Page } from '@playwright/test';

interface FixtureOptions {
  material: Record<string, unknown>;
  rgba: number[];
  tangents?: boolean;
  mirrored?: boolean;
}

async function fixture(page: Page, options: FixtureOptions): Promise<string> {
  return page.evaluate(({ material, rgba, tangents, mirrored }) => {
    // A plane with known tangent axes makes normal-map effects measurable. Nonuniform
    // scale exercises orthogonalization; negative X scale also tests reflected handedness.
    const vertices = new Float32Array([
      -1, -1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, -1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1,
      1, 1, 1, 0, 0, 1, -1, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1,
    ]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const binary = new Uint8Array(vertices.byteLength + indices.byteLength);
    binary.set(new Uint8Array(vertices.buffer));
    binary.set(new Uint8Array(indices.buffer), vertices.byteLength);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), 1, 1), 0, 0);
    return JSON.stringify({
      asset: { version: '2.0' },
      buffers: [
        {
          byteLength: binary.byteLength,
          uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...binary)),
        },
      ],
      bufferViews: [
        { buffer: 0, byteLength: vertices.byteLength, byteStride: 48 },
        { buffer: 0, byteOffset: vertices.byteLength, byteLength: indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, type: 'VEC3', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 12, type: 'VEC3', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 24, type: 'VEC2', componentType: 5126, count: 4 },
        { bufferView: 0, byteOffset: 32, type: 'VEC4', componentType: 5126, count: 4 },
        { bufferView: 1, type: 'SCALAR', componentType: 5123, count: 6 },
      ],
      images: [{ uri: canvas.toDataURL() }],
      textures: [{ source: 0, sampler: 0 }],
      samplers: [{ minFilter: 9728, magFilter: 9728 }],
      materials: [material],
      meshes: [
        {
          primitives: [
            {
              attributes: {
                POSITION: 0,
                NORMAL: 1,
                TEXCOORD_0: 2,
                ...(tangents ? { TANGENT: 3 } : {}),
              },
              indices: 4,
              material: 0,
            },
          ],
        },
      ],
      nodes: [{ mesh: 0, scale: [mirrored ? -1.4 : 1.4, 0.8, 1] }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
  }, options);
}

async function renderPixel(page: Page, options: FixtureOptions, name: string): Promise<number[]> {
  const json = await fixture(page, options);
  await page.route(`**/${name}.gltf`, (route) =>
    route.fulfill({ contentType: 'model/gltf+json', body: json }),
  );
  await page.locator('#url').fill(`http://127.0.0.1:5173/${name}.gltf`);
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText(`${name}.gltf`);
  await expect(page.locator('#warnings')).toBeEmpty();
  await expect(page.locator('#stats')).toContainText('1 pipelines');
  const screenshot = await page.locator('canvas').screenshot();
  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return [
      ...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data,
    ].slice(0, 3);
  }, screenshot.toString('base64'));
}

function closePixels(actual: number[], expected: number[], tolerance = 2): void {
  actual.forEach((channel, index) =>
    expect(Math.abs(channel - expected[index])).toBeLessThanOrEqual(tolerance),
  );
}
function linear(byte: number): number {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
});

test('metallic/roughness uses linear G/B channels even when the image also serves base color', async ({
  page,
}) => {
  const pbr = { baseColorTexture: { index: 0 }, metallicFactor: 0.8, roughnessFactor: 0.6 };
  const mapped = await renderPixel(
    page,
    {
      rgba: [17, 128, 64, 255],
      material: { pbrMetallicRoughness: { ...pbr, metallicRoughnessTexture: { index: 0 } } },
    },
    'mr-map',
  );
  const factors = await renderPixel(
    page,
    {
      rgba: [17, 128, 64, 255],
      material: {
        pbrMetallicRoughness: {
          ...pbr,
          metallicFactor: (0.8 * 64) / 255,
          roughnessFactor: (0.6 * 128) / 255,
        },
      },
    },
    'mr-factors',
  );
  closePixels(mapped, factors);
  const omitted = await renderPixel(
    page,
    { rgba: [17, 128, 64, 255], material: { pbrMetallicRoughness: pbr } },
    'mr-omitted',
  );
  expect(Math.max(...mapped.map((n, i) => Math.abs(n - omitted[i])))).toBeGreaterThan(5);
});

test('occlusion uses linear red and strength, reducing only ambient light', async ({ page }) => {
  const base = [0.6, 0.4, 0.2, 1];
  const material = {
    pbrMetallicRoughness: { baseColorFactor: base, metallicFactor: 0, roughnessFactor: 0.8 },
    emissiveFactor: [0.05, 0.03, 0.01],
  };
  const options = { rgba: [128, 25, 224, 255], material };
  const noMap = await renderPixel(page, options, 'ao-none');
  const zero = await renderPixel(
    page,
    { ...options, material: { ...material, occlusionTexture: { index: 0, strength: 0 } } },
    'ao-zero',
  );
  const full = await renderPixel(
    page,
    { ...options, material: { ...material, occlusionTexture: { index: 0, strength: 1 } } },
    'ao-full',
  );
  closePixels(zero, noMap);
  const half = await renderPixel(
    page,
    { ...options, material: { ...material, occlusionTexture: { index: 0, strength: 0.5 } } },
    'ao-half',
  );
  for (let i = 0; i < 3; i++) {
    // Direct light and emission are identical, so their contributions cancel in this difference.
    const ambientReduction = base[i] * 0.12 * (1 - 128 / 255);
    expect(Math.abs(linear(zero[i]) - linear(full[i]) - ambientReduction)).toBeLessThan(0.008);
    expect(Math.abs(linear(zero[i]) - linear(half[i]) - ambientReduction * 0.5)).toBeLessThan(
      0.008,
    );
  }
});

test('normal maps honor scale and agree across tangent and derivative bases including mirrored nodes', async ({
  page,
}) => {
  const material = {
    pbrMetallicRoughness: {
      baseColorFactor: [0.3, 0.3, 0.3, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  };
  const options = { rgba: [128, 230, 204, 255], material };
  const flat = await renderPixel(page, options, 'normal-none');
  const disabled = await renderPixel(
    page,
    { ...options, material: { ...material, normalTexture: { index: 0, scale: 0 } } },
    'normal-zero',
  );
  closePixels(disabled, flat);
  const mappedMaterial = { ...material, normalTexture: { index: 0, scale: 1 } };
  const derived = await renderPixel(
    page,
    { ...options, material: mappedMaterial },
    'normal-derived',
  );
  const authored = await renderPixel(
    page,
    { ...options, tangents: true, material: mappedMaterial },
    'normal-authored',
  );
  closePixels(authored, derived);
  expect(Math.abs(derived[0] - flat[0])).toBeGreaterThan(15);
  // X tilt makes incorrect handedness under reflection observable instead of symmetric.
  const mirroredOptions = { rgba: [230, 128, 204, 255], mirrored: true, material: mappedMaterial };
  const mirroredDerived = await renderPixel(page, mirroredOptions, 'normal-mirrored-derived');
  const mirroredAuthored = await renderPixel(
    page,
    { ...mirroredOptions, tangents: true },
    'normal-mirrored-authored',
  );
  closePixels(mirroredAuthored, mirroredDerived);
});
