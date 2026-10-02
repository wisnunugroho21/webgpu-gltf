import { expect, test } from '@playwright/test';

test('shadow allocation accounting on the real device', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PunctualLighting } = await import('/src/renderer/lighting/punctual.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    const results = [];
    for (const resolution of [256, 512, 1024] as const) {
      const lighting = new PunctualLighting(device, resolution, false);
      const internal = lighting as any;
      results.push({
        resolution,
        samples: lighting.shadowBuffer.size,
        attachment: internal.depth ? internal.depth.width * internal.depth.height * 4 : 0,
        matrices: internal.matrices?.size ?? 0,
      });
      lighting.destroy();
    }
    device.destroy();
    return results;
  });
  console.log('Shadow allocation bytes:', JSON.stringify(result));
  expect(result.map((item) => item.samples)).toEqual([4, 4, 4]);
  expect(result.every((item) => item.attachment === 0 && item.matrices === 0)).toBe(true);
});

test('shadow capacity follows light faces, shrinks, releases, and refreshes both frame groups without new layouts', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/src/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100px;height:100px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadowResolution: 512,
    });
    const internal = renderer as any;
    const device: GPUDevice = internal.device;
    const layouts = [
      internal.bindings.pipeline,
      internal.bindings.shadowPipeline,
      internal.lighting.shadowLayout,
    ];
    const allocations = new Map<GPUBuffer | GPUTexture, number>();
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = (descriptor) => {
      const buffer = createBuffer(descriptor);
      if (['Shadow depth samples', 'Shadow view matrices'].includes(descriptor.label ?? '')) {
        allocations.set(buffer, buffer.size);
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => {
          allocations.delete(buffer);
          destroy();
        };
      }
      return buffer;
    };
    const createTexture = device.createTexture.bind(device);
    device.createTexture = (descriptor) => {
      const texture = createTexture(descriptor);
      if (descriptor.label === 'Reusable shadow depth attachment') {
        allocations.set(texture, texture.width * texture.height * 4);
        const destroy = texture.destroy.bind(texture);
        texture.destroy = () => {
          allocations.delete(texture);
          destroy();
        };
      }
      return texture;
    };
    const snapshots: {
      name: string;
      memory: typeof renderer.shadowMemory;
      liveBytes: number;
      valid: boolean;
    }[] = [];
    const frame = async (name: string) => {
      device.pushErrorScope('validation');
      renderViewerFrame(renderer, 0);
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      snapshots.push({
        name,
        memory: renderer.shadowMemory,
        liveBytes: 4 + [...allocations.values()].reduce((sum, bytes) => sum + bytes, 0),
        valid: !error,
      });
      if (error) errors.push(error.message);
    };
    const asset = (types: ('directional' | 'point' | 'spot')[], intensity = 1, blend = false) => {
      // Include transmitting geometry so its cached frame group must also refresh.
      const model = materialAsset(blend ? { alphaMode: 'BLEND' } : {});
      model.gltf.materials!.push({
        extensions: { KHR_materials_transmission: { transmissionFactor: 1 } },
      });
      model.gltf.meshes!.push({
        primitives: [{ ...model.gltf.meshes![0].primitives[0], material: 2 }],
      });
      model.gltf.nodes!.push({ mesh: 2, translation: [0, 0, 1] });
      model.gltf.extensions = {
        KHR_lights_punctual: {
          lights: types.map((type) => ({
            type,
            intensity,
            ...(type === 'spot' ? { spot: { outerConeAngle: 0.7 } } : {}),
          })),
        },
      };
      types.forEach((_, light) =>
        model.gltf.nodes!.push({
          translation: [0, 1, 3],
          extensions: { KHR_lights_punctual: { light } },
        }),
      );
      model.gltf.scenes![0].nodes = model.gltf.nodes!.map((_, index) => index);
      return model;
    };
    try {
      await frame('empty');
      await renderer.setAsset(asset(['directional']));
      await frame('directional');
      const stable = internal.lighting.shadowBuffer;
      await frame('unchanged');
      const reused = stable === internal.lighting.shadowBuffer;
      await renderer.setAsset(asset(['point']));
      await frame('point');
      await renderer.setAsset(asset(['point', 'directional', 'spot']));
      await frame('mixed');
      await renderer.setAsset(asset(['point', 'point', 'point', 'point', 'point']));
      await frame('four-point-limit');
      await renderer.setAsset(asset(['directional']));
      await frame('shrink');
      renderer.setShadows({ enabled: false });
      await frame('disabled');
      renderer.setShadows({ enabled: true });
      await frame('reenabled');
      await renderer.setAsset(asset(['point'], 0));
      await frame('zero-intensity');
      await renderer.setAsset(asset(['point'], 1, true));
      await frame('no-casters');
      const fixedLayouts =
        layouts[0] === internal.bindings.pipeline &&
        layouts[1] === internal.bindings.shadowPipeline &&
        layouts[2] === internal.lighting.shadowLayout;
      renderer.destroy();
      return { snapshots, reused, fixedLayouts, remaining: allocations.size, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  console.log('Shadow memory transitions:', JSON.stringify(result.snapshots));
  expect(result.snapshots.map((item) => item.memory.maps)).toEqual([
    0, 1, 1, 6, 8, 24, 1, 0, 1, 0, 0,
  ]);
  for (const { memory, liveBytes, valid } of result.snapshots) {
    expect(valid).toBe(true);
    expect(memory.neutralBytes).toBe(4);
    expect(memory.depthSamplesBytes).toBe(memory.maps * 512 * 512 * 4);
    expect(memory.depthAttachmentBytes).toBe(memory.maps ? 512 * 512 * 4 : 0);
    expect(memory.matrixBytes).toBe(memory.maps * 256);
    expect(memory.totalBytes).toBe(liveBytes);
  }
  expect(result.reused).toBe(true);
  expect(result.fixedLayouts).toBe(true);
  expect(result.remaining).toBe(0);
  expect(result.errors).toEqual([]);
});
