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

for (const model of ['SimpleSkin', 'AnimatedMorphCube']) {
  test(`Khronos ${model} animates in the viewer`, async ({ page }) => {
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
