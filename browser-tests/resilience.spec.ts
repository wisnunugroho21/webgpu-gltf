import { expect, test } from '@playwright/test';
import type { Scene } from '../src/renderer/scene/types';

test('failed recovery is retryable and disposal cancels an in-flight reconstruction', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/browser-tests/fixtures/viewer/app/demo.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (m) => errors.push(m), {
      onDeviceLost: () => {},
      memoryProfiling: true,
    });
    await renderer.setAsset(demoAsset());
    const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
    try {
      const lose = async () => {
        const device = testDevice(renderer);
        device.destroy();
        await device.lost;
        await Promise.resolve();
      };
      await lose();
      navigator.gpu.requestAdapter = async () => null;
      let failed = false;
      try {
        await renderer.recover();
      } catch {
        failed = true;
      }
      const retryable = renderer.deviceState === 'lost';
      navigator.gpu.requestAdapter = original;
      await renderer.recover();
      const ready = renderer.deviceState === 'ready' && renderer.render(0);
      await lose();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      navigator.gpu.requestAdapter = async (options) => {
        await gate;
        return original(options);
      };
      const recovering = renderer.recover();
      renderer.destroy();
      release();
      let cancelled = false;
      try {
        await recovering;
      } catch {
        cancelled = true;
      }
      return {
        errors,
        failed,
        retryable,
        ready,
        cancelled,
        disposed: renderer.deviceState === 'disposed',
      };
    } finally {
      navigator.gpu.requestAdapter = original;
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({
    errors: [],
    failed: true,
    retryable: true,
    ready: true,
    cancelled: true,
    disposed: true,
  });
});

test('GPU budget rejects candidate allocations and releases scene leases on unload', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, AssetRegistry } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (m) => errors.push(m), {
      memoryProfiling: true,
      resourceBudgetBytes: 2097152,
      shadows: false,
      sampleCount: 1,
    });
    const assets = new AssetRegistry();
    assets.register('a', animatedAsset(), 'fixture:a');
    const first = new World(assets);
    first.createEntity({ id: 'a', model: { asset: 'a' } });
    first.update(0);
    await renderer.setWorld(first);
    if (!renderer.render(0)) throw new Error(`Initial frame: ${errors.join('; ')}`);
    await testDevice(renderer).queue.onSubmittedWorkDone();
    const before = renderer.diagnostics.memory!.liveBytes,
      handle = renderer.getRenderInstanceHandle(first.getEntity('a').model!);
    const large = new World(assets);
    for (let i = 0; i < 5000; i++) large.createEntity({ id: String(i), model: { asset: 'a' } });
    large.update(0);
    let rejected = false;
    try {
      await renderer.setWorld(large);
    } catch (error) {
      rejected = String(error).includes('budget');
    }
    await testDevice(renderer).queue.onSubmittedWorkDone();
    const rollback = renderer.diagnostics.memory!.liveBytes === before,
      retained = renderer.getRenderInstanceHandle(first.getEntity('a').model!) === handle,
      rendered = renderer.render(0);
    if (!rendered) throw new Error(`After candidate: ${errors.join('; ')}`);
    await renderer.setWorld(new World());
    await testDevice(renderer).queue.onSubmittedWorkDone();
    const unloaded = renderer.diagnostics.memory!.liveBytes < before;
    renderer.destroy();
    assets.destroy();
    canvas.remove();
    return {
      errors,
      rejected,
      rollback,
      retained,
      rendered,
      unloaded,
      released: renderer.diagnostics.memory!.liveBytes,
    };
  });
  expect(result).toEqual({
    errors: [],
    rejected: true,
    rollback: true,
    retained: true,
    rendered: true,
    unloaded: true,
    released: 0,
  });
});

test('device recovery reconstructs current world, compute outputs, handles and settings without advancing playback', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, AssetRegistry } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [],
      losses: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      sampleCount: 1,
      memoryProfiling: true,
      gpuProfiling: true,
      onDeviceLost: (message) => losses.push(message),
    });
    const assets = new AssetRegistry();
    assets.register('hero', animatedAsset(), 'fixture:hero');
    const world = new World(assets),
      entity = world.createEntity({
        id: 'hero',
        model: { asset: 'hero' },
        transform: { translation: [1, 0, 0] },
      });
    entity.model!.animation.setClock('external');
    entity.model!.animation.advance(0.35);
    world.update(350);
    await renderer.setWorld(world);
    renderer.setOutput({ exposureEV: 0.5 });
    renderer.setEnvironment({ intensity: 0.7 });
    await renderer.setEnvironmentMap({
      width: 2,
      height: 1,
      pixels: new Float32Array([4, 2, 1, 1, 1, 2, 4, 1]),
    });
    const scene = () => Reflect.get(Reflect.get(renderer, 'gpu'), 'scene') as Scene;
    const output = () => scene().updates.find((update) => update.deformation)!.deformation!;
    const read = async () => {
      const device = testDevice(renderer),
        gpu = output();
      const buffer = device.createBuffer({
        size: gpu.outputSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(gpu.output, gpu.outputOffset, buffer, 0, gpu.outputSize);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(buffer.getMappedRange()));
      buffer.unmap();
      buffer.destroy();
      return values;
    };
    try {
      renderer.render(350);
      const before = await read();
      const oldDevice = testDevice(renderer),
        oldOutput = output().output,
        oldHandle = renderer.getRenderInstanceHandle(entity.model!),
        camera = renderer.camera,
        checkpoint = entity.model!.animation.checkpoint();
      oldDevice.destroy();
      await oldDevice.lost;
      await Promise.resolve();
      const stopped = !renderer.render(350),
        lostHandle = renderer.getRenderInstanceHandle(entity.model!) === undefined;
      const a = renderer.recover(),
        b = renderer.recover();
      const serialized = a === b;
      await a;
      renderer.render(350);
      const after = await read();
      await testDevice(renderer).queue.onSubmittedWorkDone();
      const diagnostics = renderer.diagnostics;
      const preserved =
        JSON.stringify(checkpoint) === JSON.stringify(entity.model!.animation.checkpoint());
      const fresh =
        oldDevice !== testDevice(renderer) &&
        oldOutput !== output().output &&
        oldHandle !== renderer.getRenderInstanceHandle(entity.model!);
      const matched = before.every((v, i) => Math.abs(v - after[i]) < 1e-6);
      renderer.destroy();
      return {
        errors,
        losses: losses.length,
        stopped,
        lostHandle,
        serialized,
        preserved,
        fresh,
        matched,
        camera: camera === renderer.camera,
        output: renderer.outputSettings.exposureEV,
        environment: renderer.environmentSettings.intensity,
        memory: diagnostics.memory,
        released: renderer.diagnostics.memory?.liveBytes,
        timings: diagnostics.gpuTimings,
        timingSupported: diagnostics.gpuTimingSupported,
      };
    } finally {
      renderer.destroy();
      assets.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.losses).toBe(1);
  for (const key of [
    'stopped',
    'lostHandle',
    'serialized',
    'preserved',
    'fresh',
    'matched',
    'camera',
  ] as const)
    expect(result[key], key).toBe(true);
  expect(result.output).toBe(0.5);
  expect(result.environment).toBe(0.7);
  expect(result.memory!.liveBytes).toBeGreaterThan(0);
  expect(result.released).toBe(0);
  if (result.timingSupported) {
    expect(result.timings!.passTotalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings!.passes.length).toBeGreaterThan(0);
  }
});

test('single-asset recovery retains overrides and playback for the viewer facade', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (m) => errors.push(m), {
      onDeviceLost: () => {},
    });
    try {
      await renderer.setAsset(animatedAsset(), { movableNodes: [0] });
      renderer.seek(0.4);
      renderer.animation.update(400);
      renderer.setPlaying(false);
      renderer.setNodeOverride(0, { translation: [2, 1, 0] });
      const checkpoint = renderer.animation.checkpoint();
      const override = renderer.getNodeOverride(0);
      const camera = renderer.camera;
      const device = testDevice(renderer);
      device.destroy();
      await device.lost;
      await Promise.resolve();
      await renderer.recover();
      renderer.animation.update(400);
      const rendered = renderer.render(400);
      await testDevice(renderer).queue.onSubmittedWorkDone();
      return {
        errors,
        rendered,
        checkpoint: JSON.stringify(renderer.animation.checkpoint()) === JSON.stringify(checkpoint),
        override: JSON.stringify(renderer.getNodeOverride(0)) === JSON.stringify(override),
        camera: camera === renderer.camera,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({
    errors: [],
    rendered: true,
    checkpoint: true,
    override: true,
    camera: true,
  });
});

test('playable saves reload membership and gameplay while audio and inspection remain usable', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('Grounded');
  await page.locator('#audio').click();
  await expect(page.locator('#audio')).toHaveText('Audio enabled');
  await page.locator('#companion').click();
  await expect(page.locator('#companion')).toHaveText('Spawn companion');
  await page.locator('#game').click({ position: { x: 900, y: 600 } });
  await page.keyboard.down('KeyW');
  await expect(page.locator('#status')).toContainText(/[1-9]\d* footfalls/);
  await page.keyboard.up('KeyW');
  await page.locator('#pause').click();
  await expect(page.locator('#status')).toHaveText('Paused');
  await page.locator('#save').click();
  await expect(page.locator('#save-status')).toHaveText('Saved');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('engine-game-save')!));
  await page.locator('#companion').click();
  await expect(page.locator('#companion')).toHaveText('Despawn companion');
  await page.locator('#load').click();
  await expect(page.locator('#status')).toHaveText('Paused');
  await expect(page.locator('#companion')).toHaveText('Spawn companion');
  await page.locator('#inspector summary').click();
  await expect(page.locator('#inspection')).toContainText('liveBytes');
  const inspected = JSON.parse((await page.locator('#inspection').textContent()) ?? '{}');
  expect(
    inspected.world.entities.find((entity: { id: string }) => entity.id === 'player').transform
      .translation,
  ).toEqual(
    saved.scene.entities.find((entity: { id: string }) => entity.id === 'player').transform
      .translation,
  );
  await page.locator('#pause').click();
  await expect(page.locator('#status')).toContainText('Grounded');
  expect(errors).toEqual([]);
});
