import { expect, test } from '@playwright/test';

test('declared gameplay nodes leave static groups and update uploads, bounds, winding, shadows and occlusion', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/src/app/frame.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const asset = demoAsset();
    asset.gltf.nodes!.push({ children: [0] });
    asset.gltf.scenes![0].nodes = [1, 2, 3, 4];
    const original = JSON.stringify(asset.gltf);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      occlusionCulling: true,
    });
    const internal = renderer as any,
      device: GPUDevice = internal.device;
    const phases: string[] = [],
      writes: number[] = [];
    const write = device.queue.writeBuffer.bind(device.queue);
    const create = device.createCommandEncoder.bind(device);
    const frame = async () => {
      writes.length = phases.length = 0;
      renderViewerFrame(renderer, 0);
      await device.queue.onSubmittedWorkDone();
      return { writes: [...writes], phases: [...phases], instances: renderer.frameStats.instances };
    };
    try {
      const stats = await renderer.setAsset(asset, { movableNodes: [4] });
      renderer.setPlaying(false);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 8;
      const scene = internal.scene;
      const update = scene.updates[0];
      const groups = scene.draws.map((draw: any) => draw.instanceCount).sort();
      let undeclared = false;
      try {
        renderer.setNodeTransform(1, { translation: [5, 0, 0] });
      } catch {
        undeclared = true;
      }
      device.queue.writeBuffer = (...args) => {
        if (args[0] === scene.transformBuffer) writes.push(args[4] ?? 0);
        phases.push('upload');
        write(...args);
      };
      device.createCommandEncoder = (...args) => {
        const encoder = create(...args),
          render = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (...options) => {
          phases.push(options[0].label ?? 'render');
          return render(...options);
        };
        return encoder;
      };
      const initial = await frame();
      const oldCenter = update.draw.center[0];
      internal.occlusion.hidden.add(update.draw.firstInstance); // Simulate a stale hidden result.
      const generation = internal.occlusion.generation;
      renderer.setNodeOverride(4, { translation: [50, 0, 0], scale: [-1, 1, 1] });
      const moved = await frame();
      const worldX = scene.pose.nodes[0].world[12];
      const mirrored = update.draw.pipeline === update.mirrored;
      const updatedBounds = update.draw.center[0] === 50 - oldCenter;
      const invalidated =
        internal.occlusion.generation > generation &&
        !internal.occlusion.hidden.has(update.draw.firstInstance);
      const held = await frame();
      const noOp = renderer.setNodeTransform(4, { translation: [50, 0, 0], scale: [-1, 1, 1] });
      const repeated = await frame();
      renderer.clearNodeOverride(4);
      const restored = await frame();
      return {
        stats,
        groups,
        updates: scene.updates.map((u: any) => u.node),
        undeclared,
        initial,
        moved,
        held,
        repeated,
        restored,
        noOp,
        worldX,
        mirrored,
        updatedBounds,
        invalidated,
        originalUnchanged: JSON.stringify(asset.gltf) === original,
        errors,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.stats.draws).toBe(3);
  expect(result.groups).toEqual([1, 1, 2]);
  expect(result.updates).toEqual([0]);
  expect(
    result.undeclared &&
      result.mirrored &&
      result.updatedBounds &&
      result.invalidated &&
      result.originalUnchanged,
  ).toBe(true);
  expect(result.worldX).toBe(51.5);
  expect(result.moved.writes).toEqual([128]);
  expect(result.moved.instances).toBe(result.initial.instances - 1);
  expect(result.restored.instances).toBe(result.initial.instances);
  expect(result.noOp).toBe(false);
  for (const frame of [result.held, result.repeated]) {
    expect(frame.writes).toEqual([]);
    expect(frame.phases.some((label) => label.startsWith('Shadow map'))).toBe(false);
  }
  const shadow = result.moved.phases.findIndex((label) => label.startsWith('Shadow map'));
  expect(shadow).toBeGreaterThan(result.moved.phases.lastIndexOf('upload'));
  expect(result.moved.phases.indexOf('Scene rendering')).toBeGreaterThan(shadow);
});
