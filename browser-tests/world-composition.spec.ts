import { expect, test } from '@playwright/test';
import type { DeviceResources } from '../src/renderer/core/device-resources';

test('composition cache reuses surviving buckets and stays live through gameplay movement and entity-only edits', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadows: false,
    });
    const gpu = Reflect.get(renderer, 'gpu') as DeviceResources;
    try {
      const models = new ModelLibrary();
      models.register(
        'red',
        materialAsset({ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }),
        'red',
      );
      models.register(
        'blue',
        materialAsset({ pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } }),
        'blue',
      );
      const world = new World(models);
      const a = world.createEntity({ id: 'a', model: { asset: 'red' } });
      world.createEntity({ id: 'b', model: { asset: 'blue' } });
      world.update(0);
      await renderer.setWorld(world);
      const active = gpu.scene!;
      const handle = renderer.getRenderInstanceHandle(a.model!);
      const draw = active.world!.parts.get(a.model!)!.data.draws[0];
      const buckets = [...active.opaque].map(([pipeline, materials]) => ({
        pipeline,
        list: materials.get(draw.material)!,
      }));

      world.createEntity({ id: 'logic', components: { score: { value: 1 } } });
      world.update(0);
      await renderer.syncWorld(world);
      const logical = gpu.scene!;
      const sameComposition = logical.world!.composition === active.world!.composition;
      const sameLists = logical.draws === active.draws && logical.updates === active.updates;
      const privateScratch =
        logical.visibleTransparent !== active.visibleTransparent &&
        logical.pendingDeformations !== active.pendingDeformations;

      a.setTransform({ translation: [10, 0, 0], scale: [-1, 1, 1] });
      world.update(1);
      renderer.render(1);
      const mirrored = logical.updates.find((update) => update.draw === draw)!.mirrored;
      world.createEntity({ id: 'c', model: { asset: 'blue' } });
      world.update(2);
      await renderer.syncWorld(world);
      const next = gpu.scene!;
      renderer.render(2);
      return {
        errors,
        sameComposition,
        sameLists,
        privateScratch,
        survivor:
          next.draws.includes(draw) && renderer.getRenderInstanceHandle(a.model!) === handle,
        sameBuckets: buckets.every(
          ({ pipeline, list }) => next.opaque.get(pipeline)!.get(draw.material) === list,
        ),
        winding: draw.pipeline === mirrored,
        boundsCurrent: next.max[0] === draw.bounds[0].max[0] && next.max[0] === 11,
        draws: next.draws.length,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({
    errors: [],
    sameComposition: true,
    sameLists: true,
    privateScratch: true,
    survivor: true,
    sameBuckets: true,
    winding: true,
    boundsCurrent: true,
    draws: 3,
  });
});
