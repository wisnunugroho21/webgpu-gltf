import { expect, test } from '@playwright/test';

test('extension maps decode their channels and UV transforms like equivalent factors on the GPU', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/src/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = renderer as unknown as {
      device: GPUDevice;
    };
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const image = document.createElement('canvas');
    image.width = 2;
    image.height = 1;
    image
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray([20, 200, 30, 60, 128, 64, 220, 80]), 2, 1),
        0,
        0,
      );
    const blob = await new Promise<Blob>((resolve) => image.toBlob((value) => resolve(value!)));
    const pixel = async () => {
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      const png = new Image();
      png.src = canvas.toDataURL();
      await png.decode();
      const read = document.createElement('canvas');
      read.width = read.height = 160;
      const context = read.getContext('2d')!;
      context.drawImage(png, 0, 0);
      return [...context.getImageData(80, 80, 1, 1).data].slice(0, 3);
    };
    const render = async (
      extensions: Record<string, unknown>,
      textured = false,
      emissiveFactor = [0, 0, 0],
    ) => {
      const asset = materialAsset(
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.25, 0.3, 0.35, 1],
            metallicFactor: 0,
            roughnessFactor: 0.4,
          },
          emissiveFactor,
          extensions,
        },
        true,
      );
      if (textured) {
        asset.images = [blob];
        asset.gltf.textures = [{ source: 0, sampler: 0 }];
        asset.gltf.samplers = [{ minFilter: 9728, magFilter: 9728 }];
      }
      await renderer.setAsset(asset);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 4;
      renderer.camera.radius = 1;
      return pixel();
    };
    const info = {
      index: 0,
      texCoord: 0,
      extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.5, 0], scale: [0.5, 1] } },
    };
    // UV1 is 0.75, so its transform still selects the right texel. UV0 selects the left.
    const linear = (b: number) =>
      b / 255 <= 0.04045 ? b / 255 / 12.92 : ((b / 255 + 0.055) / 1.055) ** 2.4;
    const pairs: { name: string; map: number[]; factor: number[] }[] = [];
    const compare = async (
      name: string,
      map: Record<string, unknown>,
      factor: Record<string, unknown>,
    ) => pairs.push({ name, map: await render(map, true), factor: await render(factor) });
    try {
      await compare(
        'coat red',
        {
          KHR_materials_clearcoat: {
            clearcoatFactor: 0.8,
            clearcoatRoughnessFactor: 0.4,
            clearcoatTexture: info,
          },
        },
        {
          KHR_materials_clearcoat: {
            clearcoatFactor: (0.8 * 128) / 255,
            clearcoatRoughnessFactor: 0.4,
          },
        },
      );
      await compare(
        'coat roughness green',
        {
          KHR_materials_clearcoat: {
            clearcoatFactor: 1,
            clearcoatRoughnessFactor: 0.8,
            clearcoatRoughnessTexture: info,
          },
        },
        {
          KHR_materials_clearcoat: {
            clearcoatFactor: 1,
            clearcoatRoughnessFactor: (0.8 * 64) / 255,
          },
        },
      );
      await compare(
        'specular alpha',
        { KHR_materials_specular: { specularFactor: 0.8, specularTexture: info } },
        { KHR_materials_specular: { specularFactor: (0.8 * 80) / 255 } },
      );
      await compare(
        'specular color sRGB',
        {
          KHR_materials_specular: {
            specularColorFactor: [0.8, 0.7, 0.6],
            specularColorTexture: info,
          },
        },
        {
          KHR_materials_specular: {
            specularColorFactor: [linear(128) * 0.8, linear(64) * 0.7, linear(220) * 0.6],
          },
        },
      );
      await compare(
        'transmission red',
        { KHR_materials_transmission: { transmissionFactor: 0.8, transmissionTexture: info } },
        { KHR_materials_transmission: { transmissionFactor: (0.8 * 128) / 255 } },
      );
      const transmission = {
        KHR_materials_transmission: { transmissionFactor: 1 },
        KHR_materials_ior: { ior: 1 },
      };
      await compare(
        'thickness green',
        {
          ...transmission,
          KHR_materials_volume: {
            thicknessFactor: 1,
            thicknessTexture: info,
            attenuationDistance: 1,
            attenuationColor: [0.2, 0.5, 0.8],
          },
        },
        {
          ...transmission,
          KHR_materials_volume: {
            thicknessFactor: 64 / 255,
            attenuationDistance: 1,
            attenuationColor: [0.2, 0.5, 0.8],
          },
        },
      );
      // Scale zero removes coat normal XY even with a deliberately non-neutral normal map.
      await compare(
        'coat normal scale zero',
        {
          KHR_materials_clearcoat: {
            clearcoatFactor: 1,
            clearcoatRoughnessFactor: 0.4,
            clearcoatNormalTexture: {
              index: 0,
              scale: 0,
              extensions: { KHR_texture_transform: { offset: [0.5, 0] } },
            },
          },
        },
        { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.4 } },
      );
      await compare(
        'default extension objects',
        {
          KHR_materials_clearcoat: {},
          KHR_materials_specular: {},
          KHR_materials_ior: {},
          KHR_materials_transmission: {},
          KHR_materials_volume: {},
          KHR_materials_emissive_strength: {},
        },
        {},
      );
      renderer.setOutput({ toneMapping: 'reinhard' });
      pairs.push({
        name: 'HDR emissive strength',
        map: await render(
          { KHR_materials_emissive_strength: { emissiveStrength: 4 } },
          false,
          [0.5, 0.25, 0.125],
        ),
        factor: await render({}, false, [2, 1, 0.5]),
      });
      return { pairs, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  for (const pair of result.pairs)
    for (let c = 0; c < 3; c++)
      expect(Math.abs(pair.map[c] - pair.factor[c]), pair.name).toBeLessThanOrEqual(2);
});

test('glass preserves opaque HDR radiance, applies volume absorption and survives MSAA resize and replacement', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer, loadFiles } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/src/app/frame.ts');
    const { supportedExtensions } = await import('/src/gltf/extensions.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = renderer as unknown as {
      device: GPUDevice;
    };
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const render = async (thickness: number, scale = 1, distance?: number) => {
      const asset = materialAsset(
        {
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 0,
            roughnessFactor: 0,
          },
          extensions: {
            KHR_materials_ior: { ior: 1 },
            KHR_materials_specular: { specularFactor: 0 },
            KHR_materials_transmission: { transmissionFactor: 1 },
            KHR_materials_volume: {
              thicknessFactor: thickness,
              attenuationColor: [0.25, 0.5, 1],
              ...(distance === undefined ? {} : { attenuationDistance: distance }),
            },
          },
        },
        true,
      );
      asset.gltf.nodes![0].scale = [1, 1, scale];
      // Exercise the file loader's required-extension support, not just setAsset().
      asset.gltf.extensionsRequired = [...supportedExtensions];
      asset.gltf.buffers!.forEach((buffer, i) => {
        buffer.uri =
          'data:application/octet-stream;base64,' +
          btoa(String.fromCharCode(...new Uint8Array(asset.buffers[i])));
      });
      await renderer.setAsset(
        await loadFiles([new File([JSON.stringify(asset.gltf)], 'extensions.gltf')]),
      );
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 4;
      renderer.camera.radius = 1;
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      const png = new Image();
      png.src = canvas.toDataURL();
      await png.decode();
      const read = document.createElement('canvas');
      read.width = png.width;
      read.height = png.height;
      const context = read.getContext('2d')!;
      context.drawImage(png, 0, 0);
      return [
        ...context.getImageData(Math.floor(read.width / 2), Math.floor(read.height / 2), 1, 1).data,
      ].slice(0, 3);
    };
    try {
      const thin = await render(0);
      const infiniteDistance = await render(0.5);
      const absorbed = await render(0.5, 1, 1);
      canvas.style.width = '210px';
      const scaled = await render(0.5, 2, 1);
      // Removing transmission restores the ordinary one-pass path without stale bindings.
      await renderer.setAsset(materialAsset({ extensions: { KHR_materials_unlit: {} } }));
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      return {
        thin,
        infiniteDistance,
        absorbed,
        scaled,
        sampleCount: renderer.sampleCount,
        errors,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.sampleCount).toBe(4);
  const srgb = (v: number) =>
    Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  const check = (pixels: number[], linear: number[]) =>
    pixels.forEach((v, c) => expect(Math.abs(v - srgb(linear[c]))).toBeLessThanOrEqual(2));
  check(result.thin, [0.4, 0.5, 0.6]);
  check(result.infiniteDistance, [0.4, 0.5, 0.6]);
  check(result.absorbed, [0.4 * 0.5, 0.5 * Math.sqrt(0.5), 0.6]);
  check(result.scaled, [0.4 * 0.25, 0.5 * 0.5, 0.6]);
});
