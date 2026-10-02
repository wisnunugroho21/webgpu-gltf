import { expect, test } from '@playwright/test';

test('externally evaluated poses survive held/skipped frames and render without advancing simulation', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary, FollowCamera, EngineRuntime } =
      await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:240px;height:180px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      occlusionCulling: true,
    });
    const models = new ModelLibrary();
    models.register('hero', animatedAsset(), 'fixture:hero');
    const world = new World(models);
    const hero = world.createEntity({ id: 'hero', model: { asset: 'hero' } });
    hero.setTransformOwner('physics');
    const camera = new FollowCamera();
    const runtime = new EngineRuntime(world, {
      physics: () => hero.setTransform({ translation: [1, 0, 0] }, 'physics'),
    });
    const device = testDevice(renderer);
    let uploadedEye: number[] = [];
    let writes = 0,
      computes = 0;
    const write = device.queue.writeBuffer.bind(device.queue);
    device.queue.writeBuffer = (...args) => {
      writes++;
      if (args[2] instanceof Float32Array && args[2].length === 20)
        uploadedEye = Array.from(args[2].slice(16, 19));
      write(...args);
    };
    const create = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (...args) => {
      const encoder = create(...args);
      const begin = encoder.beginComputePass.bind(encoder);
      encoder.beginComputePass = (...options) => {
        computes++;
        return begin(...options);
      };
      return encoder;
    };
    const frame = async (timestamp: number) => {
      writes = computes = 0;
      camera.update([hero.worldMatrix[12], 0, 0], 0);
      const view = camera.view(renderer.aspectRatio);
      renderer.render(timestamp, view);
      await device.queue.onSubmittedWorkDone();
      return { writes, computes };
    };
    try {
      runtime.advance(0);
      await renderer.setWorld(world);
      await frame(0);
      const tick = runtime.advance(100);
      // Re-evaluation at a held timestamp must not consume GPU dirty revisions.
      world.update(tick.presentationTimeMs);
      const time = hero.model!.animation.state.time;
      const revision = hero.model!.pose.revision;
      const changed = await frame(10000);
      const repeated = await frame(20000);
      const still =
        hero.model!.animation.state.time === time && hero.model!.pose.revision === revision;
      // Skip several evaluated frames; only the latest pose needs to be uploaded.
      world.update(200);
      world.update(300);
      const latest = hero.model!.pose.revision;
      const skipped = await frame(30000);
      // Direct overrides also remain visible without another World.update call.
      hero.model!.setNodeOverride(1, { translation: [2, 0, 0] });
      const overridden = await frame(40000);
      const maintained = hero.model!.pose.revision > latest;
      let invalidAspect = false;
      try {
        renderer.render(0, camera.view(3));
      } catch {
        invalidAspect = true;
      }
      canvas.style.width = '300px';
      const resized = await frame(40000);
      return {
        changed,
        repeated,
        still,
        skipped,
        overridden,
        maintained,
        invalidAspect,
        resized,
        width: canvas.width,
        customEye: uploadedEye.every((value, index) => value === camera.eye[index]),
        errors,
      };
    } finally {
      runtime.destroy();
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.still && result.maintained && result.invalidAspect && result.customEye).toBe(true);
  expect(result.changed.computes).toBeGreaterThan(0);
  expect(result.skipped.computes).toBeGreaterThan(0);
  expect(result.overridden.computes).toBeGreaterThan(0);
  expect(result.repeated.computes).toBe(0);
  expect(result.changed.writes).toBeGreaterThan(result.repeated.writes);
  expect(result.width).toBe(300);
});
