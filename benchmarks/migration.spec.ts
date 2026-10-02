import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import type { CpuTimings } from '../src/renderer/core/cpu-timings';

test('small medium large migration baseline', async ({ page }, testInfo) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const report = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { inspectRenderer, testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const { trackAllocations } = await import('/browser-tests/helpers/allocations.ts');
    const rows = [];
    for (const [name, count] of [
      ['small', 16],
      ['medium', 128],
      ['large', 512],
    ] as const) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:240px';
      document.body.append(canvas);
      const errors: string[] = [];
      const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
        sampleCount: 1,
        shadows: false,
        cpuProfiling: true,
      });
      const device = testDevice(renderer);
      const allocations = trackAllocations(device);
      const info = device.adapterInfo;
      try {
        const start = performance.now();
        const models = new ModelLibrary();
        models.register('rigid', demoAsset(), 'fixture:demo');
        models.register('animated', animatedAsset(), 'fixture:animated');
        const world = new World(models);
        for (let i = 0; i < count; i++)
          world.createEntity({
            id: String(i),
            model: { asset: i % 4 === 0 ? 'animated' : 'rigid' },
            transform: { translation: [(i % 16) * 2, 0, -Math.floor(i / 16) * 2] },
          });
        const constructionMs = performance.now() - start;
        const preparationStart = performance.now();
        await renderer.setWorld(world);
        const preparationMs = performance.now() - preparationStart;
        renderer.camera.target = new Float32Array([15, 0, -count / 16]);
        renderer.camera.distance = Math.max(35, count / 8);
        const samples: Readonly<CpuTimings>[] = [];
        for (let frame = 0; frame < 40; frame++) {
          // A deterministic moving root plus active clips exercises dirty uploads.
          world.getEntity('0').setTransform({ translation: [Math.sin(frame / 10), 0, 0] });
          renderer.render(frame * (1000 / 60));
          const cpu = renderer.cpuTimings!;
          if (frame >= 10) samples.push(cpu);
          // Avoid accumulating GPU backlog; this wait is outside CPU measurements.
          await device.queue.onSubmittedWorkDone();
        }
        const percentile = (values: number[], fraction: number) =>
          [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
        const cpu = Object.fromEntries(
          Object.keys(samples[0]).map((key) => {
            const values = samples.map((sample) => sample[key as keyof typeof sample]);
            return [key, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
          }),
        );
        const inspection = inspectRenderer(renderer);
        const allocated = allocations.snapshot();
        renderer.destroy();
        rows.push({
          name,
          entities: count,
          animatedEntities: count / 4,
          constructionMs,
          preparationMs,
          cpu,
          scene: inspection.scene!.stats,
          frame: inspection.stats,
          allocations: allocated,
          liveBytesAfterDestroy: allocations.snapshot().liveBytes,
          device: {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
            features: [...device.features].sort(),
          },
          errors,
        });
      } finally {
        allocations.restore();
        renderer.destroy();
        canvas.remove();
      }
    }
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      workload: {
        viewport: [320, 240],
        sampleCount: 1,
        shadows: false,
        warmupFrames: 10,
        measuredFrames: 30,
        stepMs: 1000 / 60,
        animatedFraction: 0.25,
      },
      memoryScope:
        'Resources requested after renderer creation; excludes startup and swapchain. Texture payload estimates, not physical VRAM.',
      cpuScope:
        'CPU wall time for pose evaluation, uploads and command construction/submission; excludes GPU completion waits.',
      gpuExecutionMs: null,
      rows,
    };
  });
  await mkdir('test-results', { recursive: true });
  const json = JSON.stringify(report, null, 2);
  await writeFile('test-results/migration-baseline.json', json);
  await testInfo.attach('migration-baseline', { body: json, contentType: 'application/json' });
  for (const row of report.rows) {
    expect(row.errors).toEqual([]);
    expect(row.liveBytesAfterDestroy).toBe(0);
    expect(row.preparationMs).toBeGreaterThan(0);
    expect(row.allocations.requestedBytes).toBeGreaterThan(0);
    expect(Number.isFinite(row.cpu.totalMs.p95)).toBe(true);
    expect(row.frame.instances).toBeGreaterThan(0);
  }
});
