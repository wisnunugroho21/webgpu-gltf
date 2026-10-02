import { expect, test } from '@playwright/test';

test('single-asset poses and overrides survive a failed recovery before retry', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { DeviceResources } = await import('/src/renderer/core/device-resources.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:150px';
    document.body.append(canvas);
    const renderer = await Renderer.create(canvas, () => {}, { onDeviceLost: () => {} });
    await renderer.setAsset(animatedAsset(), { movableNodes: [0] });
    renderer.setPlaying(false);
    renderer.seek(0.75);
    renderer.animation.update(750);
    renderer.setNodeOverride(0, { scale: [2, 2, 2] });
    const owner = () =>
      Reflect.get(renderer, 'gpu') as Awaited<ReturnType<typeof DeviceResources.create>>;
    const previous = owner(),
      pose = previous.scene!.pose,
      animation = renderer.animation;
    const checkpoint = animation.checkpoint();
    const worlds = pose.nodes.map((node) => [...node.world]);
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    try {
      previous.device.destroy();
      await previous.device.lost;
      navigator.gpu.requestAdapter = async () => null;
      let failed = false;
      try {
        await renderer.recover();
      } catch {
        failed = true;
      }
      navigator.gpu.requestAdapter = requestAdapter;
      await renderer.recover();
      const restored =
        owner().scene!.pose === pose &&
        renderer.animation === animation &&
        JSON.stringify(animation.checkpoint()) === JSON.stringify(checkpoint) &&
        JSON.stringify(pose.nodes.map((node) => [...node.world])) === JSON.stringify(worlds);
      return {
        failed,
        restored,
        override: renderer.getNodeOverride(0),
        rendered: renderer.render(750),
      };
    } finally {
      navigator.gpu.requestAdapter = requestAdapter;
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({
    failed: true,
    restored: true,
    override: { scale: [2, 2, 2] },
    rendered: true,
  });
});

for (const mode of ['missing', 'throwing']) {
  test(`a ${mode} canvas context releases the acquired device`, async ({ page }) => {
    await page.goto('/browser-tests/fixtures/harness.html');
    const result = await page.evaluate(async (mode) => {
      const { Renderer } = await import('/src/index.ts');
      const canvas = document.createElement('canvas');
      Reflect.set(canvas, 'getContext', () => {
        if (mode === 'throwing') throw new Error('Injected getContext failure');
        return null;
      });
      const requestDevice = GPUAdapter.prototype.requestDevice;
      let destroyed = 0;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await requestDevice.apply(this, args);
        const destroy = device.destroy.bind(device);
        device.destroy = () => {
          destroyed++;
          destroy();
        };
        return device;
      };
      try {
        let failure = '';
        try {
          await Renderer.create(canvas, () => {}, { memoryProfiling: true });
        } catch (error) {
          failure = String(error);
        }
        return { failure, destroyed };
      } finally {
        GPUAdapter.prototype.requestDevice = requestDevice;
      }
    }, mode);
    expect(result.failure).toContain(
      mode === 'throwing'
        ? 'Injected getContext failure'
        : 'Could not create a WebGPU canvas context',
    );
    expect(result.destroyed).toBe(1);
  });
}

test('failed world recovery retains CPU identity and replaces exactly one resource owner on retry', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, AssetRegistry } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { DeviceResources } = await import('/src/renderer/core/device-resources.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:150px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      memoryProfiling: true,
      onDeviceLost: () => {},
    });
    const assets = new AssetRegistry();
    assets.register('hero', animatedAsset(), 'fixture:hero');
    const world = new World(assets);
    const model = world.createEntity({ id: 'hero', model: { asset: 'hero' } }).model!;
    model.animation.setClock('external');
    model.animation.advance(0.5);
    world.update(500);
    await renderer.setWorld(world);
    const owner = () =>
      Reflect.get(renderer, 'gpu') as Awaited<ReturnType<typeof DeviceResources.create>>;
    const previous = owner(),
      camera = renderer.camera,
      animation = renderer.animation;
    const checkpoint = animation.checkpoint(),
      pose = model.pose;
    const handle = renderer.getRenderInstanceHandle(model);
    const tracked = previous.device.createBuffer;
    let destroys = 0;
    const destroy = previous.device.destroy.bind(previous.device);
    previous.device.destroy = () => {
      destroys++;
      destroy();
    };
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    try {
      previous.device.destroy();
      await previous.device.lost;
      navigator.gpu.requestAdapter = async () => null;
      let failures = 0;
      for (let i = 0; i < 2; i++) {
        try {
          await renderer.recover();
        } catch {
          failures++;
        }
      }
      const retained =
        renderer.world === world &&
        renderer.animation === animation &&
        model.pose === pose &&
        owner() === previous &&
        renderer.deviceState === 'lost';
      const released = previous.scene === undefined && previous.memory!.snapshot().liveBytes === 0;
      const unwrapped = previous.device.createBuffer !== tracked;
      // One simulated loss and one owner teardown; the failed retry does not destroy twice.
      const idempotent = destroys === 2;
      navigator.gpu.requestAdapter = requestAdapter;
      await renderer.recover();
      const replacement = owner();
      const swapped =
        replacement !== previous &&
        replacement.scene?.world?.source === world &&
        renderer.getRenderInstanceHandle(model) !== handle;
      const preserved =
        renderer.camera === camera &&
        renderer.animation === animation &&
        JSON.stringify(animation.checkpoint()) === JSON.stringify(checkpoint);
      // Disposed generations cannot route delayed GPU errors into the active facade.
      previous.device.dispatchEvent(
        new GPUUncapturedErrorEvent('uncapturederror', {
          error: new GPUValidationError('stale device error'),
        }),
      );
      const rendered = renderer.render(500);
      await replacement.device.queue.onSubmittedWorkDone();
      renderer.destroy();
      renderer.destroy();
      return {
        failures,
        retained,
        released,
        unwrapped,
        idempotent,
        swapped,
        preserved,
        rendered,
        errors,
        finalBytes: replacement.memory!.snapshot().liveBytes,
        detached: renderer.world === undefined && replacement.scene === undefined,
      };
    } finally {
      navigator.gpu.requestAdapter = requestAdapter;
      renderer.destroy();
      assets.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({
    failures: 2,
    retained: true,
    released: true,
    unwrapped: true,
    idempotent: true,
    swapped: true,
    preserved: true,
    rendered: true,
    errors: [],
    finalBytes: 0,
    detached: true,
  });
});

test('late startup failure tears down completed subsystems and restores diagnostic wrappers', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { DeviceResources } = await import('/src/renderer/core/device-resources.ts');
    const canvas = document.createElement('canvas');
    const initialize = Reflect.get(DeviceResources.prototype, 'initialize') as (
      this: Awaited<ReturnType<typeof DeviceResources.create>>,
      canvas: HTMLCanvasElement,
    ) => Promise<void>;
    let owner: Awaited<ReturnType<typeof DeviceResources.create>> | undefined;
    let tracked: GPUDevice['createBuffer'] | undefined;
    let allocated = 0,
      destroyed = 0;
    Reflect.set(
      DeviceResources.prototype,
      'initialize',
      async function (
        this: Awaited<ReturnType<typeof DeviceResources.create>>,
        target: HTMLCanvasElement,
      ) {
        owner = this;
        await initialize.call(this, target);
        allocated = this.memory!.snapshot().liveBytes;
        tracked = this.device.createBuffer;
        const destroy = this.device.destroy.bind(this.device);
        this.device.destroy = () => {
          destroyed++;
          destroy();
        };
        throw new Error('Injected late startup failure');
      },
    );
    try {
      let failure = '';
      try {
        await Renderer.create(canvas, () => {}, { memoryProfiling: true, gpuProfiling: true });
      } catch (error) {
        failure = String(error);
      }
      owner?.destroy(); // Retrying cleanup must be a no-op.
      return {
        failure,
        allocated,
        destroyed,
        released: owner!.memory!.snapshot().liveBytes,
        unwrapped: owner!.device.createBuffer !== tracked,
        unusable: !owner!.isUsable,
      };
    } finally {
      Reflect.set(DeviceResources.prototype, 'initialize', initialize);
      canvas.remove();
    }
  });
  expect(result.failure).toContain('Injected late startup failure');
  expect(result.allocated).toBeGreaterThan(0);
  expect(result.destroyed).toBe(1);
  expect(result.released).toBe(0);
  expect(result.unwrapped).toBe(true);
  expect(result.unusable).toBe(true);
});

test('one cleanup failure still releases the other subsystems and CPU retention', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, AssetRegistry } = await import('/src/index.ts');
    const { demoAsset } = await import('/browser-tests/fixtures/viewer/app/demo.ts');
    const { DeviceResources } = await import('/src/renderer/core/device-resources.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:150px';
    document.body.append(canvas);
    const renderer = await Renderer.create(canvas, () => {}, { memoryProfiling: true });
    const assets = new AssetRegistry();
    assets.register('demo', demoAsset(), 'fixture:demo');
    const world = new World(assets);
    world.createEntity({ id: 'demo', model: { asset: 'demo' } });
    await renderer.setWorld(world);
    renderer.render(0);
    const gpu = Reflect.get(renderer, 'gpu') as Awaited<ReturnType<typeof DeviceResources.create>>;
    const destroyViewport = gpu.viewport.destroy.bind(gpu.viewport);
    gpu.viewport.destroy = () => {
      destroyViewport();
      throw new Error('Injected cleanup failure');
    };
    let destroys = 0;
    const destroyDevice = gpu.device.destroy.bind(gpu.device);
    gpu.device.destroy = () => {
      destroys++;
      destroyDevice();
    };
    try {
      let failure = '';
      try {
        renderer.destroy();
      } catch (error) {
        failure = String(error);
      }
      renderer.destroy();
      return {
        failure,
        destroys,
        bytes: gpu.memory!.snapshot().liveBytes,
        detached: renderer.world === undefined && gpu.scene === undefined,
        state: renderer.deviceState,
      };
    } finally {
      renderer.destroy();
      assets.destroy();
      canvas.remove();
    }
  });
  expect(result.failure).toContain('GPU resource cleanup failed');
  expect(result.destroys).toBe(1);
  expect(result.bytes).toBe(0);
  expect(result.detached).toBe(true);
  expect(result.state).toBe('disposed');
});
