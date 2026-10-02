import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('membership preparation allocation baseline', async ({ page }, testInfo) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const report = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const { trackAllocations } = await import('/browser-tests/helpers/allocations.ts');
    const rows = [];
    for (const count of [128, 512]) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:240px';
      document.body.append(canvas);
      const errors: string[] = [];
      const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
        sampleCount: 1,
        shadows: false,
      });
      const device = testDevice(renderer),
        allocations = trackAllocations(device);
      const labels: string[] = [];
      const create = device.createBuffer.bind(device);
      device.createBuffer = (descriptor) => {
        labels.push(descriptor.label ?? '');
        return create(descriptor);
      };
      const models = new ModelLibrary();
      models.register('hero', animatedAsset(), 'fixture:animated');
      const world = new World(models);
      const spawn = (target: typeof world, id: string) =>
        target.createEntity({ id, model: { asset: 'hero' } });
      const measure = async (mode: string, action: () => Promise<unknown>) => {
        const before = allocations.snapshot(),
          startLabels = labels.length;
        const start = performance.now();
        await action();
        const preparationMs = performance.now() - start;
        const after = allocations.snapshot();
        const created = labels.slice(startLabels);
        return {
          mode,
          preparationMs,
          buffers: after.buffers - before.buffers,
          requestedBytes: after.requestedBytes - before.requestedBytes,
          liveBytes: after.liveBytes,
          privateOutputs: created.filter(
            (label) =>
              label === 'Deformed vertex output' || label === 'Batched deformed vertex output',
          ).length,
          transformBindings: created.filter((label) => label === 'World model instances').length,
        };
      };
      try {
        for (let i = 0; i < count; i++) spawn(world, String(i));
        world.update(0);
        await renderer.setWorld(world);
        const original = renderer.getRenderInstanceHandle(world.getEntity('0').model!)!;
        spawn(world, 'added');
        world.update(0);
        const growth = await measure('incremental-grow', () => renderer.syncWorld(world));
        world.destroyEntity('added');
        world.update(0);
        await renderer.syncWorld(world);
        spawn(world, 'replacement');
        world.update(0);
        const reuse = await measure('incremental-reuse', () => renderer.syncWorld(world));
        const retained = renderer.getRenderInstanceHandle(world.getEntity('0').model!) === original;
        // Force a complete private-state preparation as the comparison. Model assets
        // remain shared/warm; creation of the reference's CPU world is outside timing.
        const reference = World.fromDocument(world.toDocument(), models);
        const full = await measure('full-attachment-reference', () => renderer.setWorld(reference));
        renderer.destroy();
        rows.push({
          count,
          growth,
          reuse,
          full,
          retained,
          errors,
          liveBytesAfterDestroy: allocations.snapshot().liveBytes,
          device: {
            vendor: device.adapterInfo.vendor,
            architecture: device.adapterInfo.architecture,
          },
        });
      } finally {
        renderer.destroy();
        allocations.restore();
        canvas.remove();
      }
    }
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      scope:
        'One warm preparation sample per operation, including GPU validation scope completion. CPU world construction and GPU execution timing excluded. Requested allocation bytes are estimates, not physical VRAM. Full reference forces a new attachment with shared warm assets.',
      rows,
    };
  });
  const json = JSON.stringify(report, null, 2);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/membership-baseline.json', json);
  await testInfo.attach('membership-baseline', { body: json, contentType: 'application/json' });
  for (const row of report.rows) {
    expect(row.retained).toBe(true);
    expect(row.growth.privateOutputs).toBe(2);
    expect(row.reuse.privateOutputs).toBe(2);
    expect(row.reuse.transformBindings).toBe(0);
    expect(row.full.privateOutputs).toBe((row.count + 1) * 2);
    expect(row.errors).toEqual([]);
    expect(row.liveBytesAfterDestroy).toBe(0);
  }
});
