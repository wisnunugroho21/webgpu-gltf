import { expect, test, type Page } from '@playwright/test';
import { animatedAsset } from '../tests/fixtures/animated';

async function seek(page: Page, time: number) {
  await page.locator('#animation-time').evaluate((input, value) => {
    (input as HTMLInputElement).value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, time);
  // Wait for the pose upload and a presented frame, not an arbitrary wall-clock delay.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test('clip controls render node motion, skinning and morphing, and restore the authored pose', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const asset = animatedAsset();
  asset.gltf.buffers!.forEach((buffer, index) => {
    buffer.uri =
      'data:application/octet-stream;base64,' +
      Buffer.from(asset.buffers[index]).toString('base64');
  });
  await page.route('**/animated.gltf', (route) =>
    route.fulfill({ contentType: 'model/gltf+json', body: JSON.stringify(asset.gltf) }),
  );
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  await page.locator('#url').fill('http://127.0.0.1:5173/animated.gltf');
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('animated.gltf');
  await expect(page.locator('#animation-controls')).toBeVisible();
  await expect(page.locator('#animation-clip option')).toHaveCount(4);
  const stats = await page.locator('#stats').innerText();
  for (const [index, name] of ['skin', 'morph', 'translation'].entries()) {
    await page.locator('#animation-clip').selectOption(String(index));
    await seek(page, 0);
    const before = await page.locator('canvas').screenshot();
    await seek(page, 1.5);
    const after = await page
      .locator('canvas')
      .screenshot({ path: `test-results/animation-${name}.png` });
    expect(after.equals(before)).toBe(false);
    await expect(page.locator('#animation-play')).toHaveText('Play');
    expect((await page.locator('canvas').screenshot()).equals(after)).toBe(true);
    await expect(page.locator('#stats')).toHaveText(stats); // no load-time pipeline work at seek
  }
  await page.locator('#animation-clip').selectOption('-1');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const authored = await page.locator('canvas').screenshot();
  await page.locator('#animation-clip').selectOption('1');
  await seek(page, 1.7);
  await page.locator('#animation-clip').selectOption('-1');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect((await page.locator('canvas').screenshot()).equals(authored)).toBe(true);
  expect(errors).toEqual([]);
});

test('scene preparation shares immutable deformation buffers and releases them once on failure, replacement and disposal', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const canvas = document.createElement('canvas');
    canvas.style.width = '200px';
    canvas.style.height = '150px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    type Scene = {
      updates: {
        deformation: { inputs: { base: GPUBuffer; targets: GPUBuffer }; output: GPUBuffer };
      }[];
      resources: { owned: (GPUBuffer | GPUTexture)[] };
    };
    const internal = renderer as unknown as { scene: Scene; device: GPUDevice };
    const destructions = new Map<GPUBuffer, number>();
    const track = (buffer: GPUBuffer) => {
      destructions.set(buffer, 0);
      const destroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => {
        destructions.set(buffer, destructions.get(buffer)! + 1);
        destroy();
      };
    };
    let shared = false,
      independent = false,
      preserved = false,
      fresh = false;
    let originalBuffers: GPUBuffer[] = [],
      failedBuffers: GPUBuffer[] = [],
      replacementBuffers: GPUBuffer[] = [];
    const batchedAsset = () => {
      const asset = animatedAsset();
      asset.gltf.nodes!.push({ mesh: 0, skin: 0, weights: [-0.3] });
      asset.gltf.scenes![0].nodes!.push(4);
      return asset;
    };
    try {
      await renderer.setAsset(batchedAsset());
      renderer.animation.setPlaying(false);
      const original = internal.scene;
      const [a, b] = original.updates.map((update) => update.deformation);
      shared = a.inputs.base === b.inputs.base && a.inputs.targets === b.inputs.targets;
      independent = a.output !== b.output;
      originalBuffers = original.resources.owned.filter(
        (r): r is GPUBuffer => r instanceof GPUBuffer,
      );
      originalBuffers.forEach(track);
      // Fail during material preparation after deformation uploaded shared data. Every candidate allocation must be released, preserving the scene.
      const createBuffer = internal.device.createBuffer.bind(internal.device);
      internal.device.createBuffer = (descriptor) => {
        const buffer = createBuffer(descriptor);
        failedBuffers.push(buffer);
        track(buffer);
        return buffer;
      };
      const invalid = batchedAsset();
      invalid.gltf.materials![0].pbrMetallicRoughness!.baseColorTexture = { index: 99 };
      let rejected = false;
      try {
        await renderer.setAsset(invalid);
      } catch {
        rejected = true;
      } finally {
        internal.device.createBuffer = createBuffer;
      }
      preserved =
        rejected &&
        internal.scene === original &&
        originalBuffers.every((buffer) => destructions.get(buffer) === 0);
      await renderer.setAsset(batchedAsset());
      renderer.animation.setPlaying(false);
      fresh = internal.scene.updates[0].deformation.inputs.base !== a.inputs.base;
      replacementBuffers = internal.scene.resources.owned.filter(
        (r): r is GPUBuffer => r instanceof GPUBuffer,
      );
      replacementBuffers.forEach(track);
      if (!renderer.render(0)) throw new Error('Replacement frame failed.');
      await internal.device.queue.onSubmittedWorkDone();
    } finally {
      renderer.destroy();
      canvas.remove();
    }
    return {
      shared,
      independent,
      preserved,
      fresh,
      errors,
      arenasAllocated: [originalBuffers, failedBuffers, replacementBuffers].every((buffers) =>
        buffers.some((buffer) => buffer.label === 'Batched deformed vertex output'),
      ),
      originalDestroyedOnce: originalBuffers.every((b) => destructions.get(b) === 1),
      failedDestroyedOnce:
        failedBuffers.length > 0 && failedBuffers.every((b) => destructions.get(b) === 1),
      replacementDestroyedOnce: replacementBuffers.every((b) => destructions.get(b) === 1),
    };
  });
  expect(result.errors).toEqual([]);
  expect(result.shared && result.independent && result.preserved && result.fresh).toBe(true);
  expect(result.arenasAllocated).toBe(true);
  expect(
    result.originalDestroyedOnce && result.failedDestroyedOnce && result.replacementDestroyedOnce,
  ).toBe(true);
});

for (const model of ['SimpleSkin', 'AnimatedMorphCube']) {
  test(`Khronos ${model} animates in the viewer`, { tag: '@remote' }, async ({ page }) => {
    test.skip(!process.env.TEST_REMOTE_MODELS, 'Optional live Khronos model regression.');
    test.setTimeout(90_000);
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
        `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${model}/glTF/${model}.gltf`,
      );
    await page.locator('#url-form button').click();
    await expect(page.locator('#status')).toHaveText(`${model}.gltf`, { timeout: 60_000 });
    await expect(page.locator('#animation-controls')).toBeVisible();
    await seek(page, 0);
    const before = await page.locator('canvas').screenshot();
    const duration = Number(await page.locator('#animation-time').getAttribute('max'));
    await seek(page, duration * 0.4);
    const after = await page.locator('canvas').screenshot({ path: `test-results/${model}.png` });
    expect(after.equals(before)).toBe(false);
    expect(errors).toEqual([]);
  });
}
