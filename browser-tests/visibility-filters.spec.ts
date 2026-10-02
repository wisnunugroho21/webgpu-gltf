import { expect, test } from '@playwright/test';

test('opaque occlusion removes hidden instances without changing pixels, and invalidates on camera/resize/scene changes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const scenarios = [];
    for (const sampleCount of [1, 4] as const) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:240px;height:200px';
      document.body.append(canvas);
      const errors: string[] = [];
      const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
        sampleCount,
        occlusionCulling: true,
        shadows: false,
      });
      const internal = renderer as unknown as {
        device: GPUDevice;
        occlusion: { pending: boolean; readback: GPUBuffer };
      };
      const frame = async () => {
        renderer.render(0);
        await internal.device.queue.onSubmittedWorkDone();
        // Test harness waits for asynchronous visibility; production frames never wait.
        for (let i = 0; internal.occlusion.pending && i < 100; i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        return renderer.frameStats;
      };
      const asset = demoAsset();
      asset.gltf.nodes = [
        { mesh: 0, scale: [1, 1, 0.2], translation: [0, 0, 1] },
        { mesh: 0, scale: [0.25, 0.25, 0.25], translation: [0, 0, -1] },
      ];
      asset.gltf.scenes = [{ nodes: [0, 1] }];
      const camera = () => {
        renderer.camera.target = new Float32Array([0, 0, 0]);
        renderer.camera.yaw = 0;
        renderer.camera.pitch = 0;
        renderer.camera.distance = 5;
        renderer.camera.radius = 2;
      };
      try {
        await renderer.setAsset(asset);
        camera();
        const initial = await frame();
        const reference = canvas.toDataURL();
        const culled = await frame();
        const samePixels = reference === canvas.toDataURL();
        renderer.camera.yaw = Math.PI / 2;
        const moved = await frame();
        camera();
        await frame();
        await frame();
        canvas.style.width = '260px';
        const resized = await frame();
        renderer.setOcclusionCulling(false);
        const disabled = await frame();
        renderer.setOcclusionCulling(true);
        const reenabled = await frame();
        await renderer.setAsset(asset);
        camera();
        const replaced = await frame();
        // Delay a completed query's delivery, move the camera while it is in flight,
        // then release the old result. Its zero sample count must not hide the rear cube.
        const readback = internal.occlusion.readback;
        const map = readback.mapAsync.bind(readback);
        let release!: () => void;
        const gate = new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        });
        readback.mapAsync = (...args) => map(...args).then(() => gate);
        renderer.setOcclusionCulling(true);
        await frame();
        renderer.camera.yaw = Math.PI / 2;
        const whilePending = await frame();
        readback.mapAsync = map;
        release();
        for (let i = 0; internal.occlusion.pending && i < 100; i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
        const staleIgnored = await frame();
        scenarios.push({
          sampleCount,
          initial,
          culled,
          samePixels,
          moved,
          resized,
          disabled,
          reenabled,
          replaced,
          whilePending,
          staleIgnored,
          errors,
        });
      } finally {
        renderer.destroy();
        canvas.remove();
      }
    }
    return scenarios;
  });
  for (const scenario of result) {
    expect(scenario.errors).toEqual([]);
    expect(scenario.initial.instances).toBe(2);
    expect(scenario.culled.instances).toBe(1);
    expect(scenario.samePixels).toBe(true);
    for (const stats of [
      scenario.moved,
      scenario.resized,
      scenario.disabled,
      scenario.reenabled,
      scenario.replaced,
      scenario.whilePending,
      scenario.staleIgnored,
    ])
      expect(stats.instances).toBe(2);
  }
});

test('scale threshold culls tiny projected instances and reacts to zoom and viewport size', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      scaleCulling: 10,
      shadows: false,
    });
    const internal = renderer as unknown as {
      device: GPUDevice;
    };
    const frame = async () => {
      renderer.render(0);
      await internal.device.queue.onSubmittedWorkDone();
      return renderer.frameStats;
    };
    try {
      const asset = demoAsset();
      asset.gltf.nodes = [{ mesh: 0, scale: [0.01, 0.01, 0.01] }];
      asset.gltf.scenes = [{ nodes: [0] }];
      await renderer.setAsset(asset);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.pitch = renderer.camera.yaw = 0;
      renderer.camera.distance = 5;
      renderer.camera.radius = 1;
      const tiny = await frame();
      renderer.setScaleCulling(0);
      const off = await frame();
      renderer.setScaleCulling(10);
      renderer.camera.distance = 0.1;
      const zoomed = await frame();
      renderer.camera.distance = 5;
      canvas.style.cssText = 'width:2000px;height:2000px';
      renderer.setScaleCulling(1);
      const resized = await frame();
      let rejected = 0;
      for (const value of [-1, NaN, Infinity])
        try {
          renderer.setScaleCulling(value);
        } catch {
          rejected++;
        }
      return { tiny, off, zoomed, resized, rejected, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.tiny.instances).toBe(0);
  expect(result.off.instances).toBe(1);
  expect(result.zoomed.instances).toBe(1);
  expect(result.resized.instances).toBe(1);
  expect(result.rejected).toBe(3);
});

test('BLEND, discarded MASK and transmission cannot hide opaque background geometry', async ({
  page,
}) => {
  await page.goto('/');
  const scenarios = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const scenarios = [];
    for (const transparency of ['weighted', 'sorted'] as const) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:160px;height:160px';
      document.body.append(canvas);
      const errors: string[] = [];
      const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
        transparency,
        occlusionCulling: true,
        shadows: false,
      });
      const internal = renderer as unknown as {
        device: GPUDevice;
        occlusion: { pending: boolean };
      };
      const frame = async () => {
        renderer.render(0);
        await internal.device.queue.onSubmittedWorkDone();
        for (let i = 0; internal.occlusion.pending && i < 100; i++)
          await new Promise((resolve) => setTimeout(resolve, 1));
      };
      try {
        for (const mode of ['blend', 'mask', 'glass']) {
          const asset = demoAsset();
          const primitive = {
            ...asset.gltf.meshes![0].primitives[0],
            material: asset.gltf.materials!.length,
          };
          asset.gltf.meshes!.push({ primitives: [primitive] });
          asset.gltf.materials!.push({
            alphaMode: mode === 'blend' ? 'BLEND' : mode === 'mask' ? 'MASK' : 'OPAQUE',
            doubleSided: true,
            pbrMetallicRoughness: {
              baseColorFactor: [0.6, 0.8, 0.7, mode === 'mask' ? 0 : 0.4],
              metallicFactor: 0,
              roughnessFactor: 0.3,
            },
            ...(mode === 'glass'
              ? { extensions: { KHR_materials_transmission: { transmissionFactor: 0.8 } } }
              : {}),
          });
          asset.gltf.nodes = [
            { mesh: asset.gltf.meshes!.length - 1, scale: [1, 1, 0.2], translation: [0, 0, 1] },
            { mesh: 0, scale: [0.25, 0.25, 0.25], translation: [0, 0, -1] },
          ];
          asset.gltf.scenes = [{ nodes: [0, 1] }];
          await renderer.setAsset(asset);
          renderer.camera.target = new Float32Array([0, 0, 0]);
          renderer.camera.yaw = renderer.camera.pitch = 0;
          renderer.camera.distance = 5;
          renderer.camera.radius = 2;
          await frame();
          const reference = canvas.toDataURL();
          await frame();
          scenarios.push({
            transparency,
            mode,
            samePixels: reference === canvas.toDataURL(),
            stats: renderer.frameStats,
            errors: [...errors],
          });
        }
      } finally {
        renderer.destroy();
        canvas.remove();
      }
    }
    return scenarios;
  });
  for (const scenario of scenarios) {
    expect(scenario.errors).toEqual([]);
    expect(scenario.samePixels).toBe(true);
    expect(scenario.stats.instances).toBe(2);
  }
});

test('hidden animated meshes keep computing and updating shadows, pose changes invalidate visibility, and uploads precede all encoding', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      occlusionCulling: true,
      shadows: true,
    });
    const internal = renderer as unknown as {
      device: GPUDevice;
      scene: import('../src/renderer/scene/types').Scene;
      occlusion: { pending: boolean };
    };
    const events: string[] = [];
    const device = internal.device;
    const create = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (...args) => {
      events.push('encode');
      const encoder = create(...args);
      const compute = encoder.beginComputePass.bind(encoder),
        render = encoder.beginRenderPass.bind(encoder);
      encoder.beginComputePass = (descriptor) => {
        events.push('compute');
        return compute(descriptor);
      };
      encoder.beginRenderPass = (descriptor) => {
        events.push(descriptor.label!);
        return render(descriptor);
      };
      return encoder;
    };
    const write = device.queue.writeBuffer.bind(device.queue);
    device.queue.writeBuffer = (...args) => {
      events.push('upload');
      write(...args);
    };
    const frame = async () => {
      events.length = 0;
      renderer.render(0);
      await device.queue.onSubmittedWorkDone();
      for (let i = 0; internal.occlusion.pending && i < 100; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      return { stats: renderer.frameStats, events: [...events] };
    };
    try {
      const asset = animatedAsset();
      const vertices = new Float32Array([
        -4, -4, 1, 4, -4, 1, -4, 4, 1, -4, 4, 1, 4, -4, 1, 4, 4, 1,
      ]);
      const buffer = asset.buffers.push(vertices.buffer) - 1;
      asset.gltf.buffers!.push({ byteLength: vertices.byteLength });
      const bufferView =
        asset.gltf.bufferViews!.push({ buffer, byteLength: vertices.byteLength }) - 1;
      const position =
        asset.gltf.accessors!.push({ bufferView, componentType: 5126, type: 'VEC3', count: 6 }) - 1;
      const mesh =
        asset.gltf.meshes!.push({
          primitives: [{ attributes: { POSITION: position }, material: 0 }],
        }) - 1;
      const node = asset.gltf.nodes!.push({ mesh }) - 1;
      asset.gltf.scenes![0].nodes!.push(node);
      await renderer.setAsset(asset);
      renderer.animation.setPlaying(false);
      renderer.camera.target = new Float32Array([0, 1, 0]);
      renderer.camera.pitch = renderer.camera.yaw = 0;
      renderer.camera.distance = 6;
      renderer.camera.radius = 3;
      const initial = await frame();
      const hidden = await frame();
      renderer.animation.select(1);
      renderer.animation.seek(1);
      const changed = await frame();
      const held = await frame();
      let maxError = 0;
      for (const update of internal.scene.updates) {
        const gpu = update.deformation;
        if (!gpu) continue;
        gpu.data.update();
        const readback = device.createBuffer({
          size: gpu.outputSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(gpu.output, gpu.outputOffset, readback, 0, gpu.outputSize);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const values = new Float32Array(readback.getMappedRange());
          for (const stream of gpu.data.streams) {
            const offset = { POSITION: 0, NORMAL: 4, TANGENT: 8 }[stream.semantic];
            for (let v = 0; v < gpu.count; v++)
              for (let c = 0; c < stream.width; c++)
                maxError = Math.max(
                  maxError,
                  Math.abs(values[v * 12 + offset + c] - stream.values[v * stream.width + c]),
                );
          }
          readback.unmap();
        } finally {
          readback.destroy();
        }
      }
      renderer.setScaleCulling(10000);
      renderer.animation.seek(1.5);
      const scaled = await frame();
      return { initial, hidden, changed, held, scaled, maxError, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.initial.stats.instances).toBe(3);
  expect(result.hidden.stats.instances).toBe(1);
  expect(result.changed.stats.instances).toBe(3);
  expect(result.changed.events).toContain('compute');
  expect(result.changed.events.some((event) => event.startsWith('Shadow map'))).toBe(true);
  expect(result.held.stats.instances).toBe(1);
  expect(result.held.events).not.toContain('compute');
  expect(result.scaled.stats.instances).toBe(0);
  expect(result.scaled.events).toContain('compute');
  expect(result.scaled.events.some((event) => event.startsWith('Shadow map'))).toBe(true);
  expect(result.maxError).toBeLessThan(0.00001);
  for (const frame of [result.initial, result.hidden, result.changed, result.held, result.scaled]) {
    expect(frame.events.slice(frame.events.indexOf('encode')).includes('upload')).toBe(false);
    if (frame.events.includes('Occlusion queries'))
      expect(frame.events.indexOf('Occlusion queries')).toBeGreaterThan(
        frame.events.indexOf('Scene rendering'),
      );
  }
});
