import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

/** Profile candidate staging without committing it. Removal requires no new GPU
 * model outputs, isolating CPU composition from warm resource lease acquisition. */
test('world composition phase profile', async ({ page }, testInfo) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const report = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const { trackAllocations } = await import('/browser-tests/helpers/allocations.ts');
    const { Resources } = await import('/src/renderer/core/resources.ts');
    const { prepareWorld } = await import('/src/renderer/scene/world-builder.ts');
    type Owner = import('/src/renderer/core/device-resources.ts').DeviceResources;
    type Sample = import('/src/renderer/scene/world-builder.ts').WorldPreparationProfile;
    const rows = [];
    for (const count of [128, 512, 2048]) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:320px;height:240px';
      document.body.append(canvas);
      const errors: string[] = [];
      const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
        sampleCount: 1,
        shadows: false,
      });
      // Test-only access to the device owner; no inspection API is exported.
      const gpu = Reflect.get(renderer, 'gpu') as Owner;
      const allocations = trackAllocations(gpu.device);
      try {
        const asset = materialAsset({});
        const primitive = asset.gltf.meshes![0].primitives[0];
        asset.gltf.meshes![0].primitives = Array.from({ length: 8 }, () => ({ ...primitive }));
        const library = new ModelLibrary();
        library.register('model', asset, 'fixture:composition');
        const world = new World(library);
        for (let i = 0; i < count; i++)
          world.createEntity({ id: String(i), model: { asset: 'model' } });
        world.update(0);
        await renderer.setWorld(world);
        const previous = gpu.scene!;
        world.destroyEntity(String(count - 1));
        world.update(0);
        const before = allocations.snapshot();
        const samples: Sample[] = [];
        for (let i = 0; i < 30; i++) {
          const resources = new Resources();
          try {
            const candidate = await prepareWorld(
              gpu.device,
              gpu.bindings,
              gpu.builder,
              world,
              resources,
              previous,
              (sample) => {
                if (i >= 5) samples.push(sample);
              },
            );
            if (candidate.draws.length !== (count - 1) * 8) throw new Error('Missing draws.');
          } finally {
            resources.destroy();
          }
        }
        const distribution = (values: number[]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return {
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          };
        };
        const phases = Object.fromEntries(
          Object.keys(samples[0]).map((key) => [
            key,
            distribution(samples.map((sample) => sample[key as keyof Sample])),
          ]),
        );
        const after = allocations.snapshot();
        rows.push({
          buffersAllocatedDuringCandidates: after.buffers - before.buffers,
          requestedBytesDuringCandidates: after.requestedBytes - before.requestedBytes,
          count,
          primitivesPerModel: 8,
          samples: samples.length,
          phases,
          totalMs: distribution(
            samples.map(
              (sample) =>
                sample.membershipMs +
                sample.acquisitionMs +
                sample.compositionMs +
                sample.transformsMs +
                sample.bindingMs,
            ),
          ),
          errors,
          device: {
            vendor: gpu.device.adapterInfo.vendor,
            architecture: gpu.device.adapterInfo.architecture,
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
        'Warm removal candidates, 5 warmups + 25 CPU samples, 8 opaque primitives/model. No commit, rendering, GPU completion waits or new model allocation. Composition includes current bounds, light selection, draw lists and pipeline statistics. Timings are CPU wall time and include GC; p95 is descriptive, not a CI threshold.',
      rows,
    };
  });
  const json = JSON.stringify(report, null, 2);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/world-composition-profile.json', json);
  await testInfo.attach('world-composition-profile', {
    body: json,
    contentType: 'application/json',
  });
  for (const row of report.rows) {
    expect(row.errors).toEqual([]);
    expect(row.buffersAllocatedDuringCandidates).toBe(0);
    expect(row.requestedBytesDuringCandidates).toBe(0);
  }
});
