import { expect, test } from '@playwright/test';
import type { Scene } from '../src/renderer/scene/types';

test('toon ramps retain bands, linear HDR, alpha blending and the fixed material layout', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [],
      renderer = await Renderer.create(canvas, (e) => errors.push(e), { shadows: false });
    const device = testDevice(renderer);
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const pixel = async () => {
      renderer.render(0);
      await device.queue.onSubmittedWorkDone();
      const image = new Image();
      image.src = canvas.toDataURL();
      await image.decode();
      const read = document.createElement('canvas');
      read.width = read.height = 160;
      const ctx = read.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(80, 80, 1, 1).data];
    };
    const values: number[][] = [];
    try {
      for (const cosine of [0.1, 0.3, 0.9]) {
        const angle = Math.acos(cosine);
        const asset = materialAsset({
          pbrMetallicRoughness: {
            baseColorFactor: [0.5, 0.5, 0.5, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
          extensions: { KHR_materials_specular: { specularFactor: 0 } },
          extras: { engine: { toon: { threshold: 0.5, shadowLevel: 0.3, indirectStrength: 0 } } },
        });
        asset.gltf.extensions = {
          KHR_lights_punctual: { lights: [{ type: 'directional', intensity: 4 }] },
        };
        asset.gltf.nodes!.push({
          rotation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
          extensions: { KHR_lights_punctual: { light: 0 } },
        });
        asset.gltf.scenes![0].nodes!.push(1);
        await renderer.setAsset(asset);
        renderer.camera.target = new Float32Array([0, 0, 0]);
        renderer.camera.distance = 4;
        renderer.camera.yaw = renderer.camera.pitch = 0;
        values.push(await pixel());
      }
      const hdr = materialAsset({
        emissiveFactor: [1, 0, 0],
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 8 } },
        extras: { engine: { toon: {} } },
      });
      await renderer.setAsset(hdr);
      renderer.setOutput({ toneMapping: 'reinhard', exposureEV: -2 });
      const low = await pixel();
      renderer.setOutput({ exposureEV: 0 });
      const high = await pixel();
      const alpha = materialAsset({
        alphaMode: 'BLEND',
        pbrMetallicRoughness: {
          baseColorFactor: [0, 1, 0, 0.4],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extras: { engine: { toon: { outlineWidth: 8 } } },
      });
      await renderer.setAsset(alpha);
      const blended = await pixel();
      const scene = Reflect.get(renderer, 'scene') as Scene;
      return {
        errors,
        values,
        low,
        high,
        blended,
        transparentShell: scene.draws.some((draw) => !!draw.outlinePipeline),
        draws: renderer.frameStats.draws,
      };
    } finally {
      renderer.destroy();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.values[0]).toEqual(result.values[1]);
  expect(result.values[2][0]).toBeGreaterThan(result.values[1][0] + 50);
  expect(result.high[0]).toBeGreaterThan(result.low[0]);
  expect(result.blended[1]).toBeGreaterThan(result.blended[0]);
  expect(result.transparentShell).toBe(false);
  expect(result.draws).toBe(1);
});

test('outline hulls use skinned/morphed output, mirrored winding and MSAA, and preserve held compute', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { toonAsset } = await import('/tests/fixtures/toon.ts');
    const { perspectiveView } = await import('/src/engine/camera/view.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const results = [];
    for (const sampleCount of [1, 4] as const) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const errors: string[] = [],
        renderer = await Renderer.create(canvas, (e) => errors.push(e), {
          sampleCount,
          shadows: false,
        });
      const device = testDevice(renderer),
        library = new ModelLibrary();
      library.register('toon', toonAsset(), 'local:toon');
      const world = new World(library),
        entity = world.createEntity({ id: 'character', model: { asset: 'toon' } });
      entity.model!.animation.setPlaying(false);
      entity.model!.animation.seek(0.5);
      world.update(0);
      try {
        await renderer.setWorld(world);
        const view = perspectiveView([0, 0, 6], [0, 0, 0], 1);
        const pixels = async () => {
          renderer.render(0, view);
          await device.queue.onSubmittedWorkDone();
          const image = new Image();
          image.src = canvas.toDataURL();
          await image.decode();
          const read = document.createElement('canvas');
          read.width = read.height = 256;
          const ctx = read.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, 256, 256).data;
          let outline = 0,
            partial = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 120 && pixels[i + 2] > 120 && pixels[i + 1] < 30) outline++;
            if (pixels[i] > 40 && pixels[i] < 180 && pixels[i + 2] > 40 && pixels[i + 1] < 30)
              partial++;
          }
          return { outline, partial };
        };
        const scene = () => Reflect.get(renderer, 'scene') as Scene;
        const output = scene().updates[0].deformation!.output,
          firstPipeline = scene().draws[0].outlinePipeline;
        const normal = await pixels();
        entity.setTransform({ scale: [-1, 1, 1] });
        world.update(0);
        const mirrored = await pixels();
        const switched = scene().draws[0].outlinePipeline !== firstPipeline;
        const encoder = device.createCommandEncoder.bind(device);
        let dispatches = 0;
        device.createCommandEncoder = (descriptor) => {
          const command = encoder(descriptor),
            begin = command.beginComputePass.bind(command);
          command.beginComputePass = (descriptor) => {
            dispatches++;
            return begin(descriptor);
          };
          return command;
        };
        await pixels();
        results.push({
          errors,
          normal,
          mirrored,
          switched,
          outputRetained: scene().updates[0].deformation!.output === output,
          dispatches,
          draws: renderer.frameStats.draws,
        });
      } finally {
        renderer.destroy();
        library.destroy();
      }
    }
    return results;
  });
  for (const row of result) {
    expect(row.errors).toEqual([]);
    expect(row.normal.outline).toBeGreaterThan(100);
    expect(row.mirrored.outline).toBeGreaterThan(100);
    expect(row.switched).toBe(true);
    expect(row.outputRetained).toBe(true);
    expect(row.dispatches).toBe(0);
    expect(row.draws).toBe(2);
  }
  expect(result[1].normal.partial).toBeGreaterThan(0);
});
