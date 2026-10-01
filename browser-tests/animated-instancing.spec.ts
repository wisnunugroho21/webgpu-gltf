import { expect, test } from '@playwright/test';

test('static groups in animated scenes match separate draws through parent motion and culling', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const asset = demoAsset();
    const add = (data: Float32Array, type: string) => {
      const buffer = asset.buffers.push(data.buffer) - 1;
      asset.gltf.buffers!.push({ byteLength: data.byteLength });
      const bufferView = asset.gltf.bufferViews!.push({ buffer, byteLength: data.byteLength }) - 1;
      return (
        asset.gltf.accessors!.push({
          bufferView,
          componentType: 5126,
          type,
          count: type === 'SCALAR' ? data.length : data.length / 3,
        }) - 1
      );
    };
    asset.gltf.nodes = Array.from({ length: 6 }, (_, i) => ({
      mesh: 0,
      translation: [(i - 2.5) * 0.5, -0.5, 0],
      scale: [i < 4 ? 0.2 : -0.2, 0.2, 0.2],
    }));
    asset.gltf.nodes.push(
      { children: [7] },
      { mesh: 0, translation: [0, 0.5, 0], scale: [0.2, 0.2, 0.2] },
    );
    asset.gltf.scenes = [{ nodes: [0, 1, 2, 3, 4, 5, 6] }];
    const input = add(new Float32Array([0, 2]), 'SCALAR');
    asset.gltf.animations = [
      {
        samplers: [{ input, output: add(new Float32Array([0, 0, 0, 1, 0, 0]), 'VEC3') }],
        channels: [{ sampler: 0, target: { node: 6, path: 'translation' } }],
      },
    ];
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      cpuProfiling: true,
    });
    const internal = renderer as any;
    internal.stop();
    const frame = async () => {
      internal.render(0);
      internal.stop();
      await internal.device.queue.onSubmittedWorkDone();
      return canvas.toDataURL();
    };
    const capture = async () => {
      renderer.camera.target.set([0, 0, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 4;
      renderer.setPlaying(false);
      const images = [];
      for (const time of [0, 1, 2]) {
        renderer.seek(time);
        images.push(await frame());
      }
      renderer.setFrustumCulling(false);
      images.push(await frame());
      renderer.selectAnimation(-1);
      images.push(await frame());
      renderer.setFrustumCulling(true);
      return images;
    };
    try {
      const stats = await renderer.setAsset(asset);
      const updates = internal.scene.updates.map((u: any) => u.node);
      const groups = internal.scene.draws.map((d: any) => d.instanceCount).sort();
      const images = await capture();
      const timings = renderer.cpuTimings;
      const copy = renderer.cpuTimings;
      (copy as any).totalMs = -1;
      const isolated = renderer.cpuTimings!.totalMs >= 0;
      // Constant channels force an independent-draw reference with identical poses.
      for (let node = 0; node < 6; node++) {
        const animation = asset.gltf.animations![0];
        const translation = asset.gltf.nodes![node].translation!;
        const sampler =
          animation.samplers.push({
            input,
            output: add(new Float32Array([...translation, ...translation]), 'VEC3'),
          }) - 1;
        animation.channels.push({ sampler, target: { node, path: 'translation' } });
      }
      const referenceStats = await renderer.setAsset(asset);
      const reference = await capture();
      return {
        stats,
        referenceStats,
        updates,
        groups,
        samePixels: images.map((image, i) => image === reference[i]),
        timings,
        isolated,
        errors,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.stats.draws).toBe(3);
  expect(result.stats.instances).toBe(7);
  expect(result.referenceStats.draws).toBe(7);
  expect(result.updates).toEqual([7]);
  expect(result.groups).toEqual([1, 2, 4]);
  expect(result.samePixels).toEqual([true, true, true, true, true]);
  expect(result.isolated).toBe(true);
  expect(result.timings!.totalMs).toBeGreaterThanOrEqual(0);
});
