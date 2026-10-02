import { expect, test } from '@playwright/test';

test('caller owns frames and clock, gameplay precedes GPU phases, and failures stop submissions', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { ViewerRenderLoop } = await import('/browser-tests/fixtures/viewer/app/render-loop.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:150px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadows: false,
    });
    const internal = Reflect.get(renderer, 'gpu') as any;
    const device: GPUDevice = internal.device;
    const phases: string[] = [];
    let submissions = 0;
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = (commands) => {
      submissions++;
      phases.push('submit');
      submit(commands);
    };
    const waitFrames = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    try {
      await waitFrames();
      const idleAfterCreate = submissions;
      await renderer.setAsset(animatedAsset());
      renderer.setPlaying(false);
      const prepared = submissions;
      await waitFrames();
      const idleAfterLoad = submissions - prepared;
      const write = device.queue.writeBuffer.bind(device.queue);
      device.queue.writeBuffer = (...args) => {
        phases.push('upload');
        write(...args);
      };
      const create = device.createCommandEncoder.bind(device);
      device.createCommandEncoder = (...args) => {
        const encoder = create(...args);
        const compute = encoder.beginComputePass.bind(encoder);
        encoder.beginComputePass = (...options) => {
          phases.push('compute');
          return compute(...options);
        };
        const render = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (...options) => {
          phases.push('render');
          return render(...options);
        };
        return encoder;
      };
      phases.length = 0;
      phases.push('gameplay');
      renderer.seek(1);
      phases.push('physics');
      renderer.camera.distance = 4;
      renderer.animation.update(1000);
      const submitted = renderer.render(1000);
      await device.queue.onSubmittedWorkDone();
      const first = [...phases];
      const explicitCount = submissions - prepared;
      const worldRevision = internal.scene.pose.nodes[2].worldRevision;
      await waitFrames();
      const stayedIdle =
        submissions - prepared === explicitCount &&
        internal.scene.pose.nodes[2].worldRevision === worldRevision;
      // Invalid caller clocks are rejected without poisoning the usable renderer.
      let invalid = false;
      try {
        renderer.render(NaN);
      } catch {
        invalid = true;
      }
      canvas.style.width = '123px';
      const resized = renderer.render(1016);
      const width = internal.viewport.width;
      await device.queue.onSubmittedWorkDone();
      // The viewer's adapter retains automatic frames, then fully cancels them.
      const loop = new ViewerRenderLoop(renderer);
      const beforeAdapter = submissions;
      loop.start();
      loop.start();
      await waitFrames();
      loop.stop();
      const adapterFrames = submissions - beforeAdapter;
      const stopped = submissions;
      await waitFrames();
      const adapterIdle = submissions === stopped;
      loop.destroy();
      // A synchronous preparation failure is reported once; later calls do no GPU work.
      internal.viewport.resize = () => {
        throw new Error('Injected frame failure');
      };
      const failed = renderer.render(1032);
      const afterFailure = submissions;
      const failedAgain = renderer.render(1048);
      const noFailedSubmissions = submissions === afterFailure;
      renderer.destroy();
      renderer.destroy();
      const disposed = renderer.render(1064);
      return {
        idleAfterCreate,
        idleAfterLoad,
        first,
        explicitCount,
        submitted,
        stayedIdle,
        invalid,
        resized,
        width,
        adapterFrames,
        adapterIdle,
        failed,
        failedAgain,
        noFailedSubmissions,
        disposed,
        errors,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.idleAfterCreate).toBe(0);
  expect(result.idleAfterLoad).toBe(0);
  expect(result.explicitCount).toBe(1);
  expect(result.submitted && result.stayedIdle && result.invalid && result.resized).toBe(true);
  expect(result.width).toBe(
    Math.round(123 * Math.min(await page.evaluate(() => devicePixelRatio), 2)),
  );
  expect(result.first.slice(0, 2)).toEqual(['gameplay', 'physics']);
  expect(result.first.indexOf('upload')).toBeGreaterThan(1);
  expect(result.first.indexOf('compute')).toBeGreaterThan(result.first.lastIndexOf('upload'));
  expect(result.first.indexOf('render')).toBeGreaterThan(result.first.indexOf('compute'));
  expect(result.first.at(-1)).toBe('submit');
  expect(result.adapterFrames).toBeGreaterThan(0);
  expect(result.adapterIdle && result.noFailedSubmissions).toBe(true);
  expect([result.failed, result.failedAgain, result.disposed]).toEqual([false, false, false]);
  expect(result.errors).toEqual(['Injected frame failure']);
});

test('device loss disables explicit frames and rejects later scene preparation', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/browser-tests/fixtures/viewer/app/demo.ts');
    const canvas = document.createElement('canvas');
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const device: GPUDevice = (Reflect.get(renderer, 'gpu') as any).device;
    try {
      device.destroy();
      await device.lost;
      const failed = renderer.render(0);
      const repeated = renderer.render(16);
      let rejected = false;
      try {
        await renderer.setAsset(demoAsset());
      } catch {
        rejected = true;
      }
      return { failed, repeated, rejected, errors };
    } finally {
      renderer.destroy();
    }
  });
  expect(result.failed || result.repeated).toBe(false);
  expect(result.rejected).toBe(true);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('WebGPU device lost');
});
