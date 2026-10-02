import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
test('playable lighting, toon, physics, moving poses and MSAA baseline', async ({
  page,
}, testInfo) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const report = await page.evaluate(async () => {
    const { Renderer, EngineRuntime, ActionInput, FollowCamera } = await import('/src/index.ts');
    const { RapierPhysics } = await import('/src/engine/physics/rapier.ts');
    const { createLevel } = await import('/src/game/level.ts');
    const { CharacterSimulation } = await import('/src/game/simulation.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const rows = [];
    for (const [width, height] of [
      [640, 360],
      [1280, 720],
    ]) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${width}px;height:${height}px`;
      document.body.append(canvas);
      const errors: string[] = [];
      const physics = await RapierPhysics.create(),
        world = createLevel(physics);
      world.profiling = true;
      const input = new ActionInput(),
        simulation = new CharacterSimulation(world, physics, input),
        camera = new FollowCamera();
      physics.step(1 / 60);
      const renderer = await Renderer.create(canvas, (m) => errors.push(m), {
        memoryProfiling: true,
        cpuProfiling: true,
        gpuProfiling: true,
        sampleCount: 4,
      });
      const runtime = new EngineRuntime(world, {}, { systems: simulation.systems });
      const device = testDevice(renderer),
        info = device.adapterInfo;
      const preparation = performance.now();
      await renderer.setWorld(world);
      const preparationMs = performance.now() - preparation;
      input.set('forward', true);
      input.set('aim', true);
      simulation.rootMotionEnabled = true;
      const evaluation: number[] = [],
        render: number[] = [],
        gpu: number[] = [];
      let lastGpuFrame = 0;
      try {
        for (let frame = 0; frame < 40; frame++) {
          const start = performance.now();
          runtime.advance((frame * 1000) / 60);
          const evaluated = performance.now();
          const p = world.getEntity('player').worldMatrix;
          camera.update([p[12], p[13] + 1, p[14]], 1 / 60);
          renderer.render((frame * 1000) / 60, camera.view(renderer.aspectRatio));
          const rendered = performance.now();
          if (frame >= 10) {
            evaluation.push(evaluated - start);
            render.push(rendered - evaluated);
          }
          await device.queue.onSubmittedWorkDone();
          const timing = renderer.diagnostics.gpuTimings;
          if (frame >= 10 && timing && timing.frame !== lastGpuFrame) {
            gpu.push(timing.passTotalMs);
            lastGpuFrame = timing.frame;
          }
        }
        const percentile = (values: number[], fraction: number) =>
          [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
        const summary = (values: number[]) =>
          values.length
            ? {
                p50: percentile(values, 0.5),
                p95: percentile(values, 0.95),
                samples: values.length,
              }
            : null;
        const diagnostics = renderer.diagnostics;
        renderer.destroy();
        rows.push({
          width,
          height,
          preparationMs,
          simulationCpuMs: summary(evaluation),
          cameraAndRenderCpuMs: summary(render),
          gpuPassTotalMs: summary(gpu),
          memory: diagnostics.memory,
          shadows: diagnostics.shadows,
          frame: diagnostics.frame,
          passes: diagnostics.gpuTimings?.passes,
          truncated: diagnostics.gpuTimings?.truncated,
          liveBytesAfterDestroy: renderer.diagnostics.memory?.liveBytes,
          errors,
          device: {
            vendor: info.vendor,
            architecture: info.architecture,
            description: info.description,
            features: [...device.features],
          },
          footfalls: simulation.footfalls,
        });
      } finally {
        runtime.destroy();
        renderer.destroy();
        physics.destroy();
        world.models.destroy();
        canvas.remove();
      }
    }
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      workload:
        'Original playable slice, two shared toon characters, compute morphs, aim overlays, extracted walk root motion through Rapier, moving follow camera, authored level, default environment/shadows, 4x MSAA, 10 warmup/30 measured fixed 60Hz frames. No audio/inspector.',
      scope:
        'Requested buffer/texture payload including startup, excluding swapchain/driver/query storage. CPU times exclude completion waits; GPU pass sum excludes gaps/scanout. Synthetic content, not a production anime level.',
      rows,
    };
  });
  await mkdir('test-results', { recursive: true });
  const json = JSON.stringify(report, null, 2);
  await writeFile('test-results/playable-baseline.json', json);
  await testInfo.attach('playable-baseline', { body: json, contentType: 'application/json' });
  for (const row of report.rows) {
    expect(row.errors).toEqual([]);
    expect(row.liveBytesAfterDestroy).toBe(0);
    expect(row.memory!.liveBytes).toBeGreaterThan(0);
    expect(row.footfalls).toBeGreaterThan(0);
    expect(row.truncated ?? false).toBe(false);
  }
});
