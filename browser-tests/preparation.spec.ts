import { expect, test } from '@playwright/test';

test('overlapping scene/environment preparation stays ordered and callback failures retain a usable scene', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const canvas = document.createElement('canvas');
    canvas.style.width = '100px';
    canvas.style.height = '100px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = renderer as any;
    const device: GPUDevice = internal.device;
    let depth = 0,
      maximumDepth = 0;
    const push = device.pushErrorScope.bind(device),
      pop = device.popErrorScope.bind(device);
    device.pushErrorScope = (filter) => {
      maximumDepth = Math.max(maximumDepth, ++depth);
      push(filter);
    };
    device.popErrorScope = async () => {
      try {
        return await pop();
      } finally {
        depth--;
      }
    };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const prepare = internal.builder.prepare.bind(internal.builder);
    let calls = 0;
    internal.builder.prepare = async (...args: any[]) => {
      if (++calls === 1) {
        entered();
        await gate;
      }
      return prepare(...args);
    };
    try {
      const first = renderer.setAsset(animatedAsset());
      await started;
      const next = animatedAsset();
      const second = renderer.setAsset(next);
      const environment = renderer.setEnvironmentMap({
        width: 1,
        height: 1,
        pixels: new Float32Array([1, 1, 1, 1]),
      });
      await Promise.resolve();
      const beforeRelease = calls;
      release();
      await Promise.all([first, second, environment]);
      const latest = internal.scene.pose.asset === next;
      renderer.onAnimationChange = () => {
        throw new Error('Caller notification failed');
      };
      let callbackFailure = '';
      const notified = animatedAsset();
      try {
        await renderer.setAsset(notified);
      } catch (error) {
        callbackFailure = String(error);
      }
      renderer.onAnimationChange = undefined;
      const attached = internal.scene.pose.asset === notified;
      // Encoding after the failed notification catches accidentally destroyed scene buffers.
      device.pushErrorScope('validation');
      renderer.render(0);
      await device.queue.onSubmittedWorkDone();
      const gpuError = await device.popErrorScope();
      return {
        maximumDepth,
        beforeRelease,
        latest,
        attached,
        callbackFailure,
        errors,
        gpuError: gpuError?.message,
      };
    } finally {
      release();
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.maximumDepth).toBe(1);
  expect(result.beforeRelease).toBe(1);
  expect(result.latest).toBe(true);
  expect(result.attached).toBe(true);
  expect(result.callbackFailure).toContain('Caller notification failed');
  expect(result.gpuError).toBeUndefined();
  expect(result.errors).toEqual([]);
});

test('renderer creation releases its device if canvas configuration fails', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgpu')!;
    context.configure = () => {
      throw new Error('Configuration failed');
    };
    const original = GPUAdapter.prototype.requestDevice;
    let destroyed = 0;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await original.apply(this, args);
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
        await Renderer.create(canvas, () => {});
      } catch (error) {
        failure = String(error);
      }
      return { failure, destroyed };
    } finally {
      GPUAdapter.prototype.requestDevice = original;
    }
  });
  expect(result.failure).toContain('Configuration failed');
  expect(result.destroyed).toBe(1);
});
