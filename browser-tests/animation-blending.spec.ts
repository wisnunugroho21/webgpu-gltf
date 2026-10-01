import { expect, test } from '@playwright/test';

test('renderer blends skin and morph poses before compute, preserves phase order, and skips unchanged deformation', async ({
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
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadows: false,
    });
    const internal = renderer as unknown as {
      stop(): void;
      render(timestamp: number): void;
      device: GPUDevice;
      scene: import('../src/renderer/scene/types').Scene;
    };
    internal.stop();
    const phases: string[] = [];
    let maxError = 0;
    const frames: string[][] = [];
    const dispatchCounts: number[] = [];
    let dispatchCount = 0;
    let outputBindings = false;
    try {
      const asset = animatedAsset();
      asset.gltf.nodes.push({ mesh: 0, skin: 0, weights: [-0.3] }, { mesh: 0, weights: [0.4] });
      asset.gltf.scenes[0].nodes.push(4, 5);
      await renderer.setAsset(asset);
      outputBindings = internal.scene.updates.every((update) => {
        const gpu = update.deformation!;
        return update.draw.vertices.some(
          (binding) => binding.buffer === gpu.output && binding.offset === gpu.outputOffset,
        );
      });
      const device = internal.device;
      const write = device.queue.writeBuffer.bind(device.queue);
      device.queue.writeBuffer = (...args) => {
        phases.push('upload');
        write(...args);
      };
      const create = device.createCommandEncoder.bind(device);
      device.createCommandEncoder = (...args) => {
        const encoder = create(...args);
        const beginCompute = encoder.beginComputePass.bind(encoder);
        encoder.beginComputePass = (...options) => {
          const pass = beginCompute(...options);
          const dispatch = pass.dispatchWorkgroups.bind(pass);
          pass.dispatchWorkgroups = (...counts) => {
            dispatchCount++;
            dispatch(...counts);
          };
          return pass;
        };
        const begin = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (...options) => {
          phases.push('render');
          return begin(...options);
        };
        return encoder;
      };
      for (const update of internal.scene.updates) {
        const gpu = update.deformation!;
        const dispatch = gpu.dispatchBatched.bind(gpu);
        gpu.dispatchBatched = (pass) => {
          phases.push(`compute:${update.node}`);
          dispatch(pass);
        };
      }
      const frame = async (timestamp: number) => {
        phases.length = 0;
        dispatchCount = 0;
        internal.render(timestamp);
        internal.stop();
        await device.queue.onSubmittedWorkDone();
        frames.push([...phases]);
        dispatchCounts.push(dispatchCount);
        for (const update of internal.scene.updates) {
          const gpu = update.deformation!;
          gpu.data.update(); // Independent CPU deformation oracle using the mixed pose.
          const buffer = device.createBuffer({
            size: gpu.outputSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          try {
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(gpu.output, gpu.outputOffset, buffer, 0, buffer.size);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(buffer.getMappedRange());
            for (const stream of gpu.data.streams) {
              const offset = { POSITION: 0, NORMAL: 4, TANGENT: 8 }[stream.semantic];
              for (let v = 0; v < gpu.count; v++)
                for (let c = 0; c < stream.width; c++) {
                  const error = Math.abs(
                    values[v * 12 + offset + c] - stream.values[v * stream.width + c],
                  );
                  if (!Number.isFinite(error)) throw new Error('Nonfinite blend output');
                  maxError = Math.max(maxError, error);
                }
            }
            buffer.unmap();
          } finally {
            buffer.destroy();
          }
        }
      };
      renderer.animation.setPlaying(false);
      renderer.animation.setLayers([
        { clip: 0, time: 1, weight: 0.5 },
        { clip: 1, time: 1.5, weight: 0.5 },
      ]);
      await frame(0);
      await frame(100);
      renderer.animation.setPlaying(true);
      renderer.animation.crossFadeTo(2, 1);
      await frame(200);
      await frame(700);
      renderer.animation.crossFadeTo(1, 1); // Interrupt without a compute upload at alpha zero.
      await frame(700);
      await frame(1200);
      renderer.animation.setPlaying(false);
      await frame(2000);
    } finally {
      renderer.destroy();
      canvas.remove();
    }
    return { errors, frames, maxError, dispatchCounts, outputBindings };
  });
  expect(result.errors).toEqual([]);
  expect(result.maxError).toBeLessThan(0.00001);
  expect(result.outputBindings).toBe(true);
  expect(result.dispatchCounts[0]).toBe(2); // Four nodes, two compatible batches.
  for (const index of [0, 3, 5]) {
    const phases = result.frames[index];
    const compute = phases.findIndex((phase) => phase.startsWith('compute:'));
    expect(compute).toBeGreaterThan(0);
    expect(phases.slice(0, compute).every((phase) => phase === 'upload')).toBe(true);
    expect(phases.indexOf('render')).toBeGreaterThan(compute);
    expect(phases.slice(compute).includes('upload')).toBe(false);
  }
  for (const index of [1, 2, 4, 6])
    expect(result.frames[index].filter((phase) => phase.startsWith('compute:'))).toEqual([]);
});

test('viewer clip selection exposes crossfades, pause freezes progress, and scrubbing cancels the fade', async ({
  page,
}) => {
  const { animatedAsset } = await import('../tests/fixtures/animated');
  const asset = animatedAsset();
  asset.gltf.buffers!.forEach((buffer, index) => {
    buffer.uri =
      'data:application/octet-stream;base64,' +
      Buffer.from(asset.buffers[index]).toString('base64');
  });
  await page.route('**/blending.gltf', (route) =>
    route.fulfill({ contentType: 'model/gltf+json', body: JSON.stringify(asset.gltf) }),
  );
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  await page.locator('#url').fill('http://127.0.0.1:5173/blending.gltf');
  await page.locator('#url-form button').click();
  await expect(page.locator('#status')).toHaveText('blending.gltf');
  await page.locator('#animation-fade').fill('2');
  await page.locator('#animation-clip').selectOption('1');
  await expect(page.locator('#animation-blend')).toContainText('Blending');
  await page.locator('#animation-play').click();
  await expect(page.locator('#animation-play')).toHaveText('Play');
  const held = await page.locator('#animation-blend').textContent();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator('#animation-blend')).toHaveText(held!);
  await page.locator('#animation-time').evaluate((input) => {
    (input as HTMLInputElement).value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#animation-blend')).toBeEmpty();
  await expect(page.locator('#animation-clock')).toHaveText('1.00 / 2.00 s');
  await page.locator('#animation-clip').selectOption('2'); // Paused selections are immediate.
  await expect(page.locator('#animation-blend')).toBeEmpty();
  await expect(page.locator('#animation-clock')).toHaveText('0.00 / 2.00 s');
});
