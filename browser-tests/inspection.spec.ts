import { expect, test } from '@playwright/test';

test('typed renderer inspection snapshots cannot mutate live scene state', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const { inspectRenderer, testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:120px';
    document.body.append(canvas);
    const renderer = await Renderer.create(canvas, (message) => {
      throw new Error(message);
    });
    try {
      await renderer.setAsset(demoAsset(), { movableNodes: [0] });
      renderer.render(0);
      await testDevice(renderer).queue.onSubmittedWorkDone();
      const before = inspectRenderer(renderer);
      renderer.setNodeOverride(0, { translation: [4, 0, 0] });
      renderer.render(0);
      const after = inspectRenderer(renderer);
      return {
        frozen: Object.isFrozen(before.scene!.nodes[0].world),
        before: before.scene!.nodes[0].world[12],
        after: after.scene!.nodes[0].world[12],
        sameBuffer: before.scene!.transformBuffer === after.scene!.transformBuffer,
        draws: after.scene!.stats.draws,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({ frozen: true, before: -1.5, after: 4, sameBuffer: true, draws: 3 });
});
