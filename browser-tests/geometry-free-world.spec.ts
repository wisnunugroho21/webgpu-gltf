import { expect, test } from '@playwright/test';
import type { Scene } from '../src/renderer/scene/types';

test('light-only and empty models retain identity through world membership changes', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, AssetRegistry } = await import('/src/index.ts');
    const { demoAsset } = await import('/browser-tests/fixtures/viewer/app/demo.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const device = testDevice(renderer);
    const assets = new AssetRegistry();
    assets.register(
      'light',
      {
        gltf: {
          asset: { version: '2.0' },
          extensions: { KHR_lights_punctual: { lights: [{ type: 'point', intensity: 10 }] } },
          nodes: [{ extensions: { KHR_lights_punctual: { light: 0 } } }],
          scenes: [{ nodes: [0] }],
          scene: 0,
        },
        buffers: [],
        images: [],
        warnings: [],
      },
      'fixture:light',
    );
    assets.register(
      'empty',
      { gltf: { asset: { version: '2.0' } }, buffers: [], images: [], warnings: [] },
      'fixture:empty',
    );
    assets.register('geometry', demoAsset(), 'fixture:geometry');
    const world = new World(assets);
    const light = world.createEntity({ id: 'light', model: { asset: 'light' } });
    world.createEntity({ id: 'empty', model: { asset: 'empty' } });
    const scene = () => Reflect.get(Reflect.get(renderer, 'gpu'), 'scene') as Scene;
    const frame = async () => {
      world.update(0);
      if (!renderer.render(0)) throw new Error('Frame failed');
      await device.queue.onSubmittedWorkDone();
    };
    device.pushErrorScope('validation');
    try {
      const initial = await renderer.setWorld(world);
      await frame();
      const lightHandle = renderer.getRenderInstanceHandle(light.model!)!;
      const geometry = world.createEntity({ id: 'geometry', model: { asset: 'geometry' } });
      const populated = await renderer.setWorld(world);
      await frame();
      const geometryHandle = renderer.getRenderInstanceHandle(geometry.model!)!;
      world.createEntity({ id: 'second-light', model: { asset: 'light' } });
      await renderer.setWorld(world);
      await frame();
      const retained =
        renderer.getRenderInstanceHandle(light.model!) === lightHandle &&
        renderer.getRenderInstanceHandle(geometry.model!) === geometryHandle;
      light.setTransform({ translation: [2, 3, 4] });
      await frame();
      const position = [...scene().lights.instances[0].position];
      world.destroyEntity('geometry');
      await renderer.setWorld(world);
      await frame();
      return {
        initialInstances: initial.instances,
        populatedInstances: populated.instances,
        finalInstances: scene().stats.instances,
        lights: scene().lights.instances.length,
        reserved: lightHandle.count,
        retained,
        position,
        errors,
        validation: (await device.popErrorScope())?.message,
      };
    } finally {
      renderer.destroy();
      assets.destroy();
      canvas.remove();
    }
  });
  expect(result.initialInstances).toBe(0);
  expect(result.populatedInstances).toBeGreaterThan(0);
  expect(result.finalInstances).toBe(0);
  expect(result.lights).toBe(2);
  expect(result.reserved).toBe(1);
  expect(result.retained).toBe(true);
  expect(result.position).toEqual([2, 3, 4]);
  expect(result.validation).toBeUndefined();
  expect(result.errors).toEqual([]);
});
