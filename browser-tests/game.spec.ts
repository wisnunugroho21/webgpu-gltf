import { expect, test } from '@playwright/test';
import type { Scene } from '../src/renderer/scene/types';

test('playable game boots offline, moves, pauses, resumes and changes companion membership', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/game.html');
  await expect(page.locator('#status')).toContainText('Grounded');
  await page.locator('#game').click({ position: { x: 900, y: 600 } });
  await page.keyboard.down('KeyW');
  await expect(page.locator('#status')).toContainText('Walk');
  await page.keyboard.down('ShiftLeft');
  await expect(page.locator('#status')).toContainText('Run');
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await expect(page.locator('#status')).toContainText('Idle');
  await page.keyboard.press('Space');
  await expect(page.locator('#status')).toContainText('Airborne');
  await page.locator('#pause').click();
  await expect(page.locator('#status')).toHaveText('Paused');
  await page.keyboard.press('KeyW');
  await expect(page.locator('#status')).toHaveText('Paused');
  await page.locator('#pause').click();
  await expect(page.locator('#status')).toContainText('Idle');
  await page.locator('#companion').click();
  await expect(page.locator('#companion')).toHaveText('Spawn companion');
  await expect(page.locator('#companion')).toBeEnabled();
  await page.locator('#companion').click();
  await expect(page.locator('#companion')).toHaveText('Despawn companion');
  await expect(page.locator('#companion')).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#status')).toHaveText('Paused');
  await page.keyboard.press('KeyW');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#status')).toContainText('Idle');
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(page.locator('#status')).toContainText('Grounded');
  await page.screenshot({ path: 'test-results/game-slice.png' });
  expect(errors).toEqual([]);
});

test('slice companion changes retain the player handle, pose and actual compute output', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { RapierPhysics } = await import('/src/engine/physics/rapier.ts');
    const { createLevel, addCompanion } = await import('/src/game/level.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const physics = await RapierPhysics.create(),
      world = createLevel(physics);
    const errors: string[] = [];
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const device = testDevice(renderer),
      player = world.getEntity('player').model!;
    const scene = () => Reflect.get(renderer, 'scene') as Scene;
    const output = () =>
      scene().updates.find((update) => update.pose === player.pose && update.deformation)!
        .deformation!;
    const read = async () => {
      const gpu = output();
      const staging = device.createBuffer({
        size: gpu.outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(gpu.output, gpu.outputOffset, staging, 0, gpu.outputSize);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const values = [...new Float32Array(staging.getMappedRange())];
        staging.unmap();
        return values;
      } finally {
        staging.destroy();
      }
    };
    try {
      world.update(0);
      world.update(350);
      for (const model of world.modelInstances) model.animation.setPlaying(false);
      await renderer.setWorld(world);
      renderer.render(350);
      await device.queue.onSubmittedWorkDone();
      const handle = renderer.getRenderInstanceHandle(player),
        buffer = output().output;
      const before = await read(),
        revision = player.pose.revision,
        time = player.animation.state.time;
      const distinct =
        scene().updates.filter((update) => update.deformation).length === 2 &&
        new Set(
          scene().updates.flatMap((update) =>
            update.deformation ? [update.deformation.output] : [],
          ),
        ).size === 2;
      world.destroyEntity('companion');
      await renderer.syncWorld(world);
      addCompanion(world);
      world.update(350);
      await renderer.syncWorld(world);
      renderer.render(350);
      await device.queue.onSubmittedWorkDone();
      const after = await read();
      return {
        errors,
        distinct,
        handle: renderer.getRenderInstanceHandle(player) === handle,
        buffer: output().output === buffer,
        revision: player.pose.revision === revision,
        time: player.animation.state.time === time,
        output: before.every((value, index) => value === after[index]),
        finite: after.every(Number.isFinite),
      };
    } finally {
      renderer.destroy();
      physics.destroy();
      world.models.destroy();
    }
  });
  expect(result).toEqual({
    errors: [],
    distinct: true,
    handle: true,
    buffer: true,
    revision: true,
    time: true,
    output: true,
    finite: true,
  });
});
