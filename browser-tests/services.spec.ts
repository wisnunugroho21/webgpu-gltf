import { expect, test } from '@playwright/test';

test('CPU services share loaded models, retain live GPU resources after eviction, and run gameplay before rendering', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { AssetRegistry, ComponentRegistry, loadWorld, EngineRuntime, Renderer } =
      await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { inspectRenderer, testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const asset = animatedAsset();
    let loads = 0;
    const assets = new AssetRegistry({
      resolve: async () => {
        loads++;
        return asset;
      },
    });
    const components = new ComponentRegistry('reject');
    const motion = components.register<{ speed: number }>('motion', {
      parse(value) {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.speed !== 'number'
        )
          throw new Error('speed required');
        return { speed: value.speed };
      },
    });
    const sceneDocument = {
      version: 1,
      assets: { hero: 'hero.glb' },
      entities: [
        { id: 'player', model: { asset: 'hero' }, components: { motion: { speed: 2 } } },
        { id: 'npc', model: { asset: 'hero' } },
      ],
    };
    const [world, other] = await Promise.all([
      loadWorld(sceneDocument, undefined, { assets, components }),
      loadWorld(sceneDocument, undefined, { assets, components }),
    ]);
    const player = world.getEntity('player'),
      npc = world.getEntity('npc');
    for (const model of world.modelInstances) {
      model.animation.select(-1);
      model.animation.setPlaying(false);
    }
    const shared =
      player.model!.resources === npc.model!.resources &&
      player.model!.resources === other.getEntity('player').model!.resources;
    const independent =
      player.model!.pose !== npc.model!.pose &&
      player.model!.animation !== other.getEntity('player').model!.animation;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    window.document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const device = testDevice(renderer);
    const runtime = new EngineRuntime(
      world,
      {
        present: (frame) => {
          renderer.render(frame.presentationTimeMs);
        },
      },
      {
        stepMs: 10,
        systems: [
          {
            id: 'movement',
            phase: 'gameplay',
            fixedUpdate: ({ world }, step) => {
              const player = world.getEntity('player'),
                position = player.transform.translation;
              position[0] += player.getComponent(motion)!.speed * step.deltaSeconds;
              player.setTransform({ translation: position });
            },
          },
        ],
      },
    );
    try {
      world.update(0);
      await renderer.setWorld(world);
      runtime.advance(0);
      await device.queue.onSubmittedWorkDone();
      const before = inspectRenderer(renderer);
      assets.evict('hero');
      runtime.advance(20);
      await device.queue.onSubmittedWorkDone();
      const after = inspectRenderer(renderer);
      const retained =
        before.scene!.transformBuffer === after.scene!.transformBuffer &&
        before.scene!.draws.every((draw, i) =>
          draw.vertices.every(
            (vertex, j) => vertex.buffer === after.scene!.draws[i].vertices[j].buffer,
          ),
        );
      const registryEvicted = assets.inspect('hero').status === 'declared';
      await assets.load('hero');
      const restored = assets.getModel('hero') === player.model!.resources;
      assets.destroy();
      runtime.advance(30);
      await device.queue.onSubmittedWorkDone();
      return {
        loads,
        shared,
        independent,
        retained,
        registryEvicted,
        restored,
        x: player.worldMatrix[12],
        errors,
      };
    } finally {
      runtime.destroy();
      renderer.destroy();
      canvas.remove();
      assets.destroy();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.loads).toBe(2);
  expect(
    result.shared &&
      result.independent &&
      result.retained &&
      result.registryEvicted &&
      result.restored,
  ).toBe(true);
  expect(result.x).toBeCloseTo(0.06);
});
