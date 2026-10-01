import { expect, test } from '@playwright/test';

test('unrelated animation reuses history and in-flight transparent results invalidate only the moved receiver', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:240px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      occlusionCulling: true,
      shadows: true,
    });
    const internal = renderer as any;
    internal.stop();
    const asset = demoAsset();
    asset.gltf.materials.push({
      alphaMode: 'BLEND',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] },
    });
    asset.gltf.meshes.push({
      primitives: [{ ...asset.gltf.meshes[0].primitives[0], material: 2 }],
    });
    asset.gltf.nodes = [
      { mesh: 1, translation: [0, 0, 1], scale: [1, 1, 0.2] },
      { mesh: 0, translation: [0, 0, -1], scale: [0.25, 0.25, 0.25] },
      { mesh: 2, translation: [0, 0, -1], scale: [0.25, 0.25, 0.25] },
      {},
    ];
    asset.gltf.scenes = [{ nodes: [0, 1, 2, 3] }];
    const add = (data: Float32Array, type: string) => {
      const buffer = asset.buffers.push(data.buffer) - 1;
      asset.gltf.buffers.push({ byteLength: data.byteLength });
      const bufferView = asset.gltf.bufferViews.push({ buffer, byteLength: data.byteLength }) - 1;
      return asset.gltf.accessors.push({ bufferView, type, componentType: 5126, count: 2 }) - 1;
    };
    const input = add(new Float32Array([0, 2]), 'SCALAR');
    asset.gltf.animations = [3, 2, 0].map((node) => ({
      samplers: [
        {
          input,
          output: add(
            new Float32Array([0, 0, node === 0 ? 1 : -1, 2, 0, node === 0 ? 1 : -1]),
            'VEC3',
          ),
        },
      ],
      channels: [{ sampler: 0, target: { node, path: 'translation' } }],
    }));
    const device: GPUDevice = internal.device;
    const frame = async (wait = true) => {
      internal.render(0);
      internal.stop();
      await device.queue.onSubmittedWorkDone();
      if (wait)
        for (let i = 0; internal.occlusion.pending && i < 200; i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        frame: renderer.frameStats,
        queries: renderer.occlusionStats.queries,
        known: renderer.occlusionStats.knownInstances,
      };
    };
    try {
      await renderer.setAsset(asset);
      renderer.setPlaying(false);
      renderer.camera.target.set([0, 0, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 8;
      await frame();
      const hidden = await frame();
      renderer.seek(1);
      const unrelated = await frame();
      const stablePixels = canvas.toDataURL();
      renderer.setOcclusionCulling(false);
      await frame();
      const samePixels = stablePixels === canvas.toDataURL();
      renderer.setOcclusionCulling(true);
      await frame();
      await frame();
      renderer.selectAnimation(1);
      renderer.seek(0);
      await frame();
      await frame();
      // Hold a query result for this receiver at the old hidden location.
      renderer.setOcclusionCulling(true);
      const readback: GPUBuffer = internal.occlusion.readback;
      const map = readback.mapAsync.bind(readback);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      readback.mapAsync = (...args) => map(...args).then(() => gate);
      await frame(false);
      renderer.seek(2);
      const pending = await frame(false);
      readback.mapAsync = map;
      release();
      for (let i = 0; internal.occlusion.pending && i < 200; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      const receiver = await frame();
      const fresh = await frame();
      // Moving the opaque wall invalidates all history and suppresses futile queries
      // after consecutive changes; stopping immediately resumes fresh query work.
      renderer.selectAnimation(2);
      renderer.seek(0);
      await frame();
      renderer.seek(0.4);
      await frame();
      renderer.seek(1.5);
      const moving = await frame();
      const stopped = await frame();
      const recovered = await frame();
      return {
        hidden,
        unrelated,
        samePixels,
        pending,
        receiver,
        fresh,
        moving,
        stopped,
        recovered,
        discarded: renderer.occlusionStats.discardedResults,
        errors,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.hidden.frame.instances).toBe(1);
  expect(result.hidden.queries).toBe(0);
  expect(result.unrelated.frame.instances).toBe(1);
  expect(result.unrelated.queries).toBe(0);
  expect(result.samePixels).toBe(true);
  expect(result.pending.frame.instances).toBe(3); // Unknown old opaque query and moved receiver both fail open.
  expect(result.receiver.frame.instances).toBe(2); // Static rear cube remains hidden; moved glass draws.
  expect(result.receiver.queries).toBe(1);
  expect(result.fresh.frame.instances).toBe(2);
  expect(result.discarded).toBeGreaterThan(0);
  expect(result.moving.queries).toBe(0);
  expect(result.moving.frame.instances).toBe(3);
  expect(result.stopped.queries).toBeGreaterThan(0);
  expect(result.recovered.frame.instances).toBe(3);
});
