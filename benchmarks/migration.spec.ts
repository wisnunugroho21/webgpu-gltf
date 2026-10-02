import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import type { CpuTimings } from '../src/renderer/core/cpu-timings';
import type { World } from '../src/engine/world';

test('small medium large migration baseline', async ({ page }, testInfo) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const report = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { demoAsset } = await import('/browser-tests/fixtures/viewer/app/demo.ts');
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
        memoryProfiling: true,
        gpuProfiling: true,
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
        world.profiling = true;
        for (let i = 0; i < count; i++)
          world.createEntity({
            id: String(i),
            model: { asset: i % 4 === 0 ? 'animated' : 'rigid' },
            transform: { translation: [(i % 16) * 2, 0, -Math.floor(i / 16) * 2] },
          });
        const constructionMs = performance.now() - start;
        const preparationStart = performance.now();
        world.updateTransforms();
        await renderer.setWorld(world);
        const preparationMs = performance.now() - preparationStart;
        renderer.camera.target = new Float32Array([15, 0, -count / 16]);
        renderer.camera.distance = Math.max(35, count / 8);
        const samples: Readonly<CpuTimings>[] = [];
        const gpuSamples: number[] = [];
        let gpuFrame = 0;
        const evaluationSamples: NonNullable<World['cpuTimings']>[] = [];
        for (let frame = 0; frame < 40; frame++) {
          // A deterministic moving root plus active clips exercises dirty uploads.
          world.getEntity('0').setTransform({ translation: [Math.sin(frame / 10), 0, 0] });
          world.update(frame * (1000 / 60));
          renderer.render(frame * (1000 / 60));
          const cpu = renderer.cpuTimings!;
          if (frame >= 10) {
            samples.push(cpu);
            evaluationSamples.push(world.cpuTimings!);
          }
          // Avoid accumulating GPU backlog; this wait is outside CPU measurements.
          await device.queue.onSubmittedWorkDone();
          const gpu = renderer.diagnostics.gpuTimings;
          if (frame >= 10 && gpu && gpu.frame !== gpuFrame) {
            gpuSamples.push(gpu.passTotalMs);
            gpuFrame = gpu.frame;
          }
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
        const evaluationCpu = Object.fromEntries(
          Object.keys(evaluationSamples[0]).map((key) => {
            const values = evaluationSamples.map((sample) => sample[key as keyof typeof sample]);
            return [key, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
          }),
        );
        const allocated = allocations.snapshot();
        const completeMemory = renderer.diagnostics.memory;
        const gpuExecution = gpuSamples.length
          ? {
              p50: percentile(gpuSamples, 0.5),
              p95: percentile(gpuSamples, 0.95),
              samples: gpuSamples.length,
            }
          : null;
        renderer.destroy();
        rows.push({
          name,
          entities: count,
          animatedEntities: count / 4,
          constructionMs,
          preparationMs,
          cpu,
          evaluationCpu,
          scene: inspection.scene!.stats,
          frame: inspection.stats,
          allocations: allocated,
          completeMemory,
          gpuExecution,
          completeLiveBytesAfterDestroy: renderer.diagnostics.memory?.liveBytes,
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
      schemaVersion: 3,
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
        'allocations: after renderer creation, excludes startup; completeMemory: includes renderer startup. Both exclude swapchain/driver/query storage. Texture payload estimates, not physical VRAM.',
      cpuScope:
        'cpu: render-only uploads/visibility/command construction/submission; evaluationCpu: engine pose evaluation. Excludes GPU completion waits; legacy renderer pose fields are zero.',
      gpuScope:
        'Optional sum of measured GPU pass durations; excludes between-pass gaps and presentation scanout. No CPU-derived GPU timing.',
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
    expect(row.completeLiveBytesAfterDestroy).toBe(0);
    expect(row.preparationMs).toBeGreaterThan(0);
    expect(row.allocations.requestedBytes).toBeGreaterThan(0);
    expect(Number.isFinite(row.cpu.totalMs.p95)).toBe(true);
    expect(row.frame.instances).toBeGreaterThan(0);
  }
});
