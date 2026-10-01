import { expect, test } from '@playwright/test';

test('culls individual instances without changing pixels, and follows camera and viewport changes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = renderer as unknown as {
      stop(): void;
      render(t: number): void;
      device: GPUDevice;
    };
    internal.stop();
    const frame = async () => {
      internal.render(0);
      internal.stop();
      await internal.device.queue.onSubmittedWorkDone();
    };
    try {
      const asset = demoAsset();
      asset.gltf.nodes = [-1, 30, 1, 0, 0].map((x, i) => ({
        mesh: 0,
        translation: [x, 0, i === 3 ? 30 : 0],
        scale: [0.25, 0.25, 0.25],
      }));
      asset.gltf.scenes = [{ nodes: [0, 1, 2, 3, 4] }];
      const prepared = await renderer.setAsset(asset);
      renderer.camera.target.set([0, 0, 0]);
      renderer.camera.yaw = 0;
      renderer.camera.pitch = 0;
      renderer.camera.distance = 4;
      renderer.camera.radius = 1;
      await frame();
      const visible = renderer.frameStats;
      const culledImage = canvas.toDataURL();
      renderer.setFrustumCulling(false);
      await frame();
      const all = renderer.frameStats;
      const samePixels = culledImage === canvas.toDataURL();
      renderer.setFrustumCulling(true);
      renderer.camera.target.set([30, 0, 0]);
      await frame();
      const moved = renderer.frameStats;
      renderer.camera.target.set([0, 0, 0]);
      canvas.style.width = '50px';
      await frame();
      const narrow = renderer.frameStats;
      canvas.style.width = '200px';
      renderer.camera.target.set([-0.7, 0, 0]);
      await frame();
      const partial = renderer.frameStats;
      const edgeImage = canvas.toDataURL();
      renderer.setFrustumCulling(false);
      await frame();
      const sameEdgePixels = edgeImage === canvas.toDataURL();
      return { prepared, visible, all, samePixels, moved, narrow, partial, sameEdgePixels, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.prepared.instances).toBe(5);
  expect(result.visible).toEqual({ draws: 3, instances: 3, culledInstances: 2 });
  expect(result.all).toEqual({ draws: 1, instances: 5, culledInstances: 0 });
  expect(result.samePixels).toBe(true);
  expect(result.moved).toEqual({ draws: 1, instances: 1, culledInstances: 4 });
  expect(result.narrow).toEqual({ draws: 1, instances: 1, culledInstances: 4 });
  expect(result.partial.instances).toBe(3);
  expect(result.sameEdgePixels).toBe(true);
});

test('updates skinned and morphed bounds while offscreen, including blended nonindexed draws', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:240px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = renderer as unknown as {
      stop(): void;
      render(t: number): void;
      device: GPUDevice;
      scene: {
        pose: {
          clips: {
            tracks: { node: number; path: string; width: number; values: Float32Array }[];
          }[];
        };
        updates: { deformation?: { dispatch(pass: GPUComputePassEncoder): void } }[];
      };
    };
    internal.stop();
    let dispatches = 0;
    const frame = async () => {
      internal.render(0);
      internal.stop();
      await internal.device.queue.onSubmittedWorkDone();
    };
    try {
      const asset = animatedAsset();
      asset.gltf.materials![0].alphaMode = 'BLEND';
      await renderer.setAsset(asset);
      renderer.animation.setPlaying(false);
      renderer.camera.target.set([0, 1, 0]);
      renderer.camera.yaw = 0;
      renderer.camera.pitch = 0;
      renderer.camera.distance = 5;
      renderer.camera.radius = 1;
      // Move the skeleton's parent and the morph-only mesh together. The skin's
      // mesh node is deliberately far away: its compute output is in world space.
      internal.scene.pose.clips[0].tracks = [1, 3].map((node) => ({
        ...internal.scene.pose.clips[2].tracks[0],
        node,
        path: 'translation',
        width: 3,
        values: new Float32Array([20, 0, 0, 0, 0, 0]),
      }));
      for (const update of internal.scene.updates)
        if (update.deformation) {
          const original = update.deformation.dispatch.bind(update.deformation);
          update.deformation.dispatch = (pass) => {
            dispatches++;
            original(pass);
          };
        }
      renderer.animation.seek(0);
      await frame();
      const outside = renderer.frameStats;
      const outsideDispatches = dispatches;
      dispatches = 0;
      renderer.animation.seek(2);
      await frame();
      const returned = renderer.frameStats;
      const returnDispatches = dispatches;
      const image = canvas.toDataURL();
      renderer.setFrustumCulling(false);
      await frame();
      const samePixels = image === canvas.toDataURL();
      // Exercise signed morph bounds as well as joint envelopes.
      renderer.setFrustumCulling(true);
      renderer.animation.select(1);
      internal.scene.pose.clips[1].tracks.forEach((track) => {
        track.values = new Float32Array([-2, 3]);
      });
      const morphMatches: boolean[] = [];
      for (const time of [0, 1, 2]) {
        renderer.animation.seek(time);
        await frame();
        const culled = canvas.toDataURL();
        renderer.setFrustumCulling(false);
        await frame();
        morphMatches.push(culled === canvas.toDataURL());
        renderer.setFrustumCulling(true);
      }
      return {
        errors,
        outside,
        returned,
        outsideDispatches,
        returnDispatches,
        samePixels,
        morphMatches,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.outside).toEqual({ draws: 0, instances: 0, culledInstances: 2 });
  expect(result.outsideDispatches).toBe(2);
  expect(result.returned).toEqual({ draws: 2, instances: 2, culledInstances: 0 });
  expect(result.returnDispatches).toBe(1);
  expect(result.samePixels).toBe(true);
  expect(result.morphMatches).toEqual([true, true, true]);
});
