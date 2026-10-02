import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('wide and deep hierarchy dirty evaluation compared with the previous algorithm', async ({
  page,
}, testInfo) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const report = await page.evaluate(async () => {
    const { World } = await import('/src/engine/world.ts');
    const { HistoricalHierarchy } = await import('/benchmarks/historical-hierarchy.ts');
    const rows = [];
    for (const shape of ['wide', 'deep'] as const)
      for (const count of [1000, 10000, 25000]) {
        const definitions = Array.from({ length: count }, (_, i) => ({
          id: String(i),
          ...(i ? { parent: shape === 'wide' ? '0' : String(i - 1) } : {}),
          transform: { translation: [1, 0, 0] },
        }));
        if (shape === 'deep') definitions.reverse(); // Authored child-before-parent order.
        const construct = performance.now();
        const world = new World();
        world.applyChanges(definitions.map((entity) => ({ type: 'create', entity })));
        const constructionMs = performance.now() - construct;
        const initialize = performance.now();
        world.updateTransforms();
        const initializationMs = performance.now() - initialize;
        const legacy = new HistoricalHierarchy(definitions);
        let legacyError: string | null = null;
        try {
          legacy.update();
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          legacyError = error.name;
        }
        for (const mode of ['held', 'leaf', 'root'] as const) {
          const samples: number[] = [],
            oldSamples: number[] = [];
          let matrices = 0,
            oldMatrices = 0,
            visited = 0;
          for (let frame = 0; frame < 40; frame++) {
            if (mode !== 'held') {
              const id = mode === 'leaf' ? String(count - 1) : '0';
              const translation = [1 + (frame % 2) * 0.1, 0, 0];
              world.getEntity(id).setTransform({ translation });
              legacy.setTranslation(id, translation);
            }
            const start = performance.now();
            world.updateTransforms();
            const elapsed = performance.now() - start;
            if (frame >= 10) {
              samples.push(elapsed);
              matrices = world.hierarchyStats.recomputedWorlds;
              visited = world.hierarchyStats.visitedEntities;
            }
            if (!legacyError) {
              const before = performance.now();
              oldMatrices = legacy.update();
              if (frame >= 10) oldSamples.push(performance.now() - before);
            }
          }
          const summary = (values: number[]) => {
            if (!values.length) return null;
            values.sort((a, b) => a - b);
            return {
              p50Ms: values[Math.ceil(values.length * 0.5) - 1],
              p95Ms: values[Math.ceil(values.length * 0.95) - 1],
            };
          };
          rows.push({
            shape,
            count,
            mode,
            constructionMs,
            initializationMs,
            current: { timing: summary(samples), matrices, visited },
            previous: {
              timing: summary(oldSamples),
              matrices: legacyError ? null : oldMatrices,
              error: legacyError,
            },
          });
        }
      }
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      platform: navigator.platform,
      logicalProcessors: navigator.hardwareConcurrency,
      workload: {
        warmupFrames: 10,
        measuredFrames: 30,
        shapes: ['wide', 'deep'],
        counts: [1000, 10000, 25000],
      },
      scope:
        'CPU hierarchy evaluation only, no GPU or animation. Historical reference reproduces recursive full traversal and parent copies. Deep input is child-before-parent. Timings may be timer-quantized; matrix counts are deterministic.',
      rows,
    };
  });
  await mkdir('test-results', { recursive: true });
  const json = JSON.stringify(report, null, 2);
  await writeFile('test-results/hierarchy-baseline.json', json);
  await testInfo.attach('hierarchy-baseline', { body: json, contentType: 'application/json' });
  for (const row of report.rows) {
    expect(row.current.matrices).toBe(
      row.mode === 'held' ? 0 : row.mode === 'leaf' ? 1 : row.count,
    );
    if (!row.previous.error) expect(row.previous.matrices).toBe(row.count);
  }
});
