import { expect, test } from '@playwright/test';

test('playback uploads and dispatches only affected transforms, weights and influencing joint palettes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const canvas = document.createElement('canvas');
    canvas.style.width = '200px';
    canvas.style.height = '150px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    type Update = {
      node: number;
      deformation: {
        paletteBuffer: GPUBuffer;
        weightsBuffer: GPUBuffer;
        dispatch(pass: GPUComputePassEncoder): void;
      };
    };
    const internal = renderer as unknown as {
      stop(): void;
      render(timestamp: number): void;
      device: GPUDevice;
      scene: {
        updates: Update[];
        transformBuffer: GPUBuffer;
        pose: { clips: { tracks: { interpolation: string }[] }[] };
      };
    };
    internal.stop(); // Drive deterministic frames; don't race the automatic RAF loop.
    const asset = animatedAsset();
    asset.gltf.nodes.push(
      { mesh: 0, weights: [0.3], translation: [-2, 0, 0] },
      { mesh: 0, skin: 1, weights: [0.3] },
      { children: [7] },
      { translation: [0, 1, 0] },
      { children: [3, 4], translation: [2, 0, 0] },
      { translation: [2, 0, 0] },
    );
    asset.gltf.skins.push({ joints: [6, 7] });
    asset.gltf.skins[0].joints.push(9); // No positive influence references this joint.
    delete asset.gltf.skins[0].inverseBindMatrices;
    asset.gltf.scenes[0].nodes = [0, 1, 5, 6, 8, 9];
    for (const node of [8, 9, 0])
      asset.gltf.animations.push({
        name: `Translation ${node}`,
        samplers: asset.gltf.animations[2].samplers,
        channels: [{ sampler: 0, target: { node, path: 'translation' } }],
      });
    const writes: { node?: number; kind: string; offset: number; size?: number }[] = [];
    const dispatched: number[] = [];
    const snapshots: { name: string; writes: typeof writes; dispatched: number[] }[] = [];
    try {
      await renderer.setAsset(asset);
      const scene = internal.scene;
      const buffers = new Map<GPUBuffer, { node: number; kind: string }>();
      for (const update of scene.updates) {
        buffers.set(update.deformation.paletteBuffer, { node: update.node, kind: 'palette' });
        buffers.set(update.deformation.weightsBuffer, { node: update.node, kind: 'weights' });
        const dispatch = update.deformation.dispatch.bind(update.deformation);
        update.deformation.dispatch = (pass) => {
          dispatched.push(update.node);
          dispatch(pass);
        };
      }
      const writeBuffer = internal.device.queue.writeBuffer.bind(internal.device.queue);
      internal.device.queue.writeBuffer = (...args) => {
        const [buffer, offset, , , size] = args;
        if (buffer === scene.transformBuffer) writes.push({ kind: 'transform', offset, size });
        else if (buffers.has(buffer)) writes.push({ ...buffers.get(buffer)!, offset, size });
        writeBuffer(...args);
      };
      const frame = async (timestamp: number) => {
        internal.render(timestamp);
        internal.stop();
        await internal.device.queue.onSubmittedWorkDone();
      };
      const clear = () => {
        writes.length = 0;
        dispatched.length = 0;
      };
      const capture = (name: string) =>
        snapshots.push({
          name,
          writes: writes.map((write) => ({ ...write })),
          dispatched: [...dispatched].sort((a, b) => a - b),
        });
      await frame(0);
      capture('initial');
      clear();
      await frame(500);
      capture('joint');
      scene.pose.clips[0].tracks[0].interpolation = 'STEP';
      renderer.animation.seek(0);
      await frame(600);
      clear();
      await frame(1100);
      capture('STEP hold');
      renderer.animation.setPlaying(false);
      // Establish each clip's starting pose, then measure only its changed sample.
      for (const [clip, name] of [
        [1, 'morph'],
        [2, 'mesh transform'],
        [3, 'parent'],
        [4, 'unused joint'],
        [5, 'skinned mesh transform'],
      ] as const) {
        renderer.animation.select(clip);
        renderer.animation.seek(0);
        await frame(2000 + clip * 100);
        clear();
        renderer.animation.seek(1);
        await frame(2050 + clip * 100);
        capture(name);
        clear();
        renderer.animation.seek(1);
        await frame(2075 + clip * 100);
        capture(`${name} repeat`);
      }
      internal.device.queue.writeBuffer = writeBuffer;
      return {
        snapshots,
        errors,
        transformOffsets: scene.updates
          .filter((u) => u.node === 3 || u.node === 4)
          .map((u) => ({
            node: u.node,
            offset: (u as unknown as { draw: { firstInstance: number } }).draw.firstInstance * 128,
          })),
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  const snapshot = (name: string) => result.snapshots.find((s) => s.name === name)!;
  expect(snapshot('initial').dispatched).toEqual([0, 3, 4, 5]);
  expect(snapshot('joint').dispatched).toEqual([0]);
  expect(snapshot('joint').writes.map((w) => [w.kind, w.node])).toEqual([['palette', 0]]);
  expect(snapshot('morph').dispatched).toEqual([0, 3]);
  expect(
    snapshot('morph')
      .writes.map((w) => [w.kind, w.node])
      .sort(),
  ).toEqual([
    ['weights', 0],
    ['weights', 3],
  ]);
  const offset = result.transformOffsets.find((record) => record.node === 3)!.offset;
  expect(snapshot('mesh transform').dispatched).toEqual([]);
  expect(snapshot('mesh transform').writes).toEqual([{ kind: 'transform', offset, size: 128 }]);
  expect(snapshot('parent').dispatched).toEqual([]);
  expect(snapshot('parent').writes).toEqual([{ kind: 'transform', offset, size: 256 }]);
  for (const s of result.snapshots.filter(
    (s) =>
      s.name.endsWith('repeat') ||
      ['STEP hold', 'unused joint', 'skinned mesh transform'].includes(s.name),
  )) {
    expect(s.writes, s.name).toEqual([]);
    expect(s.dispatched, s.name).toEqual([]);
  }
});
