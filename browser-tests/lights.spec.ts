import { expect, test } from '@playwright/test';

test('authored light color, intensity, distance, cone and animation reach HDR shading', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadows: false,
    });
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
    };
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const pixel = async () => {
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      const image = new Image();
      image.src = canvas.toDataURL();
      await image.decode();
      const read = document.createElement('canvas');
      read.width = read.height = 160;
      const ctx = read.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(80, 80, 1, 1).data].slice(0, 3);
    };
    const values: Record<string, number[]> = {};
    const render = async (
      name: string,
      type: 'directional' | 'point' | 'spot',
      intensity: number,
      color = [1, 1, 1],
      position = [0, 0, 2],
      range?: number,
      rotation?: number[],
    ) => {
      const asset = materialAsset({
        pbrMetallicRoughness: {
          baseColorFactor: [0.4, 0.4, 0.4, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      });
      asset.gltf.extensions = {
        KHR_lights_punctual: {
          lights: [
            {
              type,
              intensity,
              color,
              range,
              ...(type === 'spot' ? { spot: { innerConeAngle: 0.1, outerConeAngle: 0.3 } } : {}),
            },
          ],
        },
      };
      asset.gltf.nodes!.push({
        translation: position,
        rotation,
        extensions: { KHR_lights_punctual: { light: 0 } },
      });
      asset.gltf.scenes![0].nodes!.push(1);
      await renderer.setAsset(asset);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.distance = 4;
      renderer.camera.yaw = renderer.camera.pitch = 0;
      values[name] = await pixel();
      return asset;
    };
    try {
      await render('dark', 'directional', 0);
      await render('directional', 'directional', 1);
      await render('red', 'directional', 1, [1, 0, 0]);
      await render('pointNear', 'point', 4);
      await render('pointFar', 'point', 4, [1, 1, 1], [0, 0, 4]);
      await render('rangedOut', 'point', 4, [1, 1, 1], [0, 0, 2], 1);
      await render('spotCenter', 'spot', 4);
      await render('spotOut', 'spot', 4, [1, 1, 1], [0, 0, 2], undefined, [
        0,
        Math.sin(0.5),
        0,
        Math.cos(0.5),
      ]);
      const asset = await render('animationStart', 'point', 4);
      const times = new Float32Array([0, 1]),
        translation = new Float32Array([0, 0, 2, 0, 0, 4]);
      for (const [data, type, count] of [
        [times, 'SCALAR', 2],
        [translation, 'VEC3', 2],
      ] as const) {
        const buffer = asset.buffers.push(data.buffer) - 1;
        const view = asset.gltf.bufferViews!.push({ buffer, byteLength: data.byteLength }) - 1;
        asset.gltf.accessors!.push({ bufferView: view, componentType: 5126, type, count });
      }
      asset.gltf.animations = [
        {
          samplers: [{ input: 6, output: 7 }],
          channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
        },
      ];
      await renderer.setAsset(asset);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.distance = 4;
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.animation.setPlaying(false);
      renderer.animation.seek(1);
      values.animationEnd = await pixel();
      return { values, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  const v = result.values;
  expect(v.directional[0]).toBeGreaterThan(v.dark[0] + 30);
  expect(v.red[0]).toBeGreaterThan(v.red[1] + 30);
  expect(v.red[1]).toBe(v.dark[1]);
  for (const name of ['pointNear', 'spotCenter'])
    for (let c = 0; c < 3; c++)
      expect(Math.abs(v[name][c] - v.directional[c])).toBeLessThanOrEqual(2);
  expect(v.pointFar[0]).toBeLessThan(v.pointNear[0] - 20);
  expect(v.rangedOut).toEqual(v.dark);
  expect(v.spotOut).toEqual(v.dark);
  expect(Math.abs(v.animationEnd[0] - v.pointFar[0])).toBeLessThanOrEqual(2);
  expect(result.errors).toEqual([]);
});

test('directional, spot and point shadows darken receivers; camera culling retains offscreen casters', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadowResolution: 256,
    });
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
      lighting: { encode(encoder: GPUCommandEncoder, scene: unknown): void };
    };
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const pixels = async () => {
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      const image = new Image();
      image.src = canvas.toDataURL();
      await image.decode();
      const read = document.createElement('canvas');
      read.width = read.height = 200;
      const ctx = read.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(0, 0, 200, 200).data];
    };
    const counts = [];
    try {
      for (const type of ['directional', 'spot', 'point'] as const) {
        const asset = materialAsset({
          pbrMetallicRoughness: {
            baseColorFactor: [0.6, 0.6, 0.6, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        });
        asset.gltf.nodes = [
          { mesh: 0, scale: [3, 3, 1] },
          {
            mesh: 0,
            translation: type === 'directional' ? [-2.5, 0, 1.5] : [0, 0, 1],
            scale: [0.3, 0.3, 1],
          },
          {
            translation: [-2, 1, 4],
            rotation:
              type === 'directional'
                ? [0, Math.sin(-Math.asin(0.9) / 2), 0, Math.cos(-Math.asin(0.9) / 2)]
                : [0, -Math.sin(Math.atan(0.5) / 2), 0, Math.cos(Math.atan(0.5) / 2)],
            extensions: { KHR_lights_punctual: { light: 0 } },
          },
        ];
        asset.gltf.scenes = [{ nodes: [0, 1, 2] }];
        asset.gltf.extensions = {
          KHR_lights_punctual: {
            lights: [
              {
                type,
                intensity: type === 'directional' ? 3 : 30,
                ...(type === 'spot' ? { spot: { innerConeAngle: 0.6, outerConeAngle: 1 } } : {}),
              },
            ],
          },
        };
        await renderer.setAsset(asset);
        renderer.camera.target = new Float32Array([0, 0, 0]);
        renderer.camera.distance = 4;
        renderer.camera.yaw = type === 'directional' ? 0 : 0.4;
        renderer.camera.pitch = 0;
        renderer.setShadows({ enabled: false });
        const lit = await pixels();
        renderer.setShadows({ enabled: true });
        const shadowed = await pixels();
        let darker = 0;
        for (let i = 0; i < lit.length; i += 4) if (lit[i] - shadowed[i] > 20) darker++;
        const culled = renderer.frameStats.culledInstances;
        renderer.setFrustumCulling(false);
        const uncull = await pixels();
        let difference = 0;
        for (let i = 0; i < uncull.length; i++)
          difference = Math.max(difference, Math.abs(uncull[i] - shadowed[i]));
        counts.push({ type, darker, culled, difference });
        renderer.setFrustumCulling(true);
      }
      return { counts, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  for (const item of result.counts) {
    expect(item.darker, item.type).toBeGreaterThan(50);
    expect(item.difference).toBe(0);
  }
  expect(result.counts[0].culled).toBeGreaterThan(0);
  expect(result.errors).toEqual([]);
});

test('shadow MASK coverage uses the selected transformed UVs; glass and BLEND do not cast opaque shadows', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:200px;height:200px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadowResolution: 256,
    });
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
    };
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = 2;
    imageCanvas.height = 1;
    imageCanvas
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255]), 2, 1),
        0,
        0,
      );
    const image = await new Promise<Blob>((resolve) =>
      imageCanvas.toBlob((blob) => resolve(blob!)),
    );
    const pixels = async () => {
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      const picture = new Image();
      picture.src = canvas.toDataURL();
      await picture.decode();
      const read = document.createElement('canvas');
      read.width = read.height = 200;
      const ctx = read.getContext('2d')!;
      ctx.drawImage(picture, 0, 0);
      return ctx.getImageData(0, 0, 200, 200).data;
    };
    const counts: Record<string, number> = {};
    try {
      for (const mode of ['opaque', 'maskHole', 'maskUV1', 'blend', 'glass']) {
        const asset = materialAsset({
          pbrMetallicRoughness: {
            baseColorFactor: [0.6, 0.6, 0.6, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        });
        asset.gltf.materials![1] = {
          pbrMetallicRoughness: {
            baseColorTexture: {
              index: 0,
              ...(mode === 'maskUV1'
                ? {
                    extensions: {
                      KHR_texture_transform: { texCoord: 1, scale: [0.5, 1], offset: [0.5, 0] },
                    },
                  }
                : {}),
            },
          },
          alphaMode: mode.startsWith('mask') ? 'MASK' : mode === 'blend' ? 'BLEND' : 'OPAQUE',
          ...(mode === 'glass'
            ? { extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } }
            : {}),
        };
        asset.images = [image];
        asset.gltf.textures = [{ source: 0, sampler: 0 }];
        asset.gltf.samplers = [{ minFilter: 9728, magFilter: 9728 }];
        asset.gltf.nodes = [
          { mesh: 0, scale: [3, 3, 1] },
          { mesh: 1, translation: [-2.5, 0, 1.5], scale: [0.3, 0.3, 1] },
          {
            rotation: [0, Math.sin(-Math.asin(0.9) / 2), 0, Math.cos(-Math.asin(0.9) / 2)],
            extensions: { KHR_lights_punctual: { light: 0 } },
          },
        ];
        asset.gltf.extensions = {
          KHR_lights_punctual: { lights: [{ type: 'directional', intensity: 3 }] },
        };
        asset.gltf.scenes = [{ nodes: [0, 1, 2] }];
        await renderer.setAsset(asset);
        renderer.camera.target = new Float32Array([0, 0, 0]);
        renderer.camera.distance = 4;
        renderer.camera.yaw = renderer.camera.pitch = 0;
        renderer.setShadows({ enabled: false });
        const lit = await pixels();
        renderer.setShadows({ enabled: true });
        const shadow = await pixels();
        let darker = 0;
        for (let i = 0; i < lit.length; i += 4) if (lit[i] - shadow[i] > 20) darker++;
        counts[mode] = darker;
      }
      return { counts, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.counts.opaque).toBeGreaterThan(50);
  expect(result.counts.maskUV1).toBeGreaterThan(50);
  expect(result.counts.maskHole).toBe(0);
  expect(result.counts.blend).toBe(0);
  expect(result.counts.glass).toBe(0);
  expect(result.errors).toEqual([]);
});

test('shadows follow computed deformation and reuse static poses; unrelated animation does not refresh maps', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:150px;height:150px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      shadowResolution: 256,
    });
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
    };
    const asset = animatedAsset();
    const node = asset.gltf.nodes!.push({}) - 1;
    asset.gltf.scenes![0].nodes!.push(node);
    asset.gltf.animations!.push({
      name: 'Unrelated',
      samplers: asset.gltf.animations![2].samplers,
      channels: [{ sampler: 0, target: { node, path: 'translation' } }],
    });
    const events: string[] = [];
    const createEncoder = internal.device.createCommandEncoder.bind(internal.device);
    internal.device.createCommandEncoder = (...args) => {
      const encoder = createEncoder(...args);
      const render = encoder.beginRenderPass.bind(encoder),
        compute = encoder.beginComputePass.bind(encoder);
      encoder.beginRenderPass = (descriptor) => {
        if (descriptor.label?.startsWith('Shadow map')) events.push('shadow');
        else if (descriptor.label === 'Scene rendering') events.push('color');
        return render(descriptor);
      };
      encoder.beginComputePass = (descriptor) => {
        events.push('compute');
        return compute(descriptor);
      };
      return encoder;
    };
    const frame = async () => {
      events.length = 0;
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      return [...events];
    };
    try {
      await renderer.setAsset(asset);
      renderer.animation.setPlaying(false);
      const initial = await frame();
      const held = await frame();
      renderer.animation.seek(1);
      const changed = await frame();
      const repeated = await frame();
      renderer.animation.select(3);
      renderer.animation.seek(0);
      await frame();
      renderer.animation.seek(1);
      const unrelated = await frame();
      renderer.setShadows({ enabled: false });
      const disabled = await frame();
      renderer.setShadows({ enabled: true });
      const reenabled = await frame();
      return { initial, held, changed, repeated, unrelated, disabled, reenabled, errors };
    } finally {
      internal.device.createCommandEncoder = createEncoder;
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.initial).toContain('shadow');
  expect(result.held).not.toContain('shadow');
  expect(result.changed).toContain('compute');
  expect(result.changed.indexOf('compute')).toBeLessThan(result.changed.indexOf('shadow'));
  expect(result.changed.indexOf('shadow')).toBeLessThan(result.changed.indexOf('color'));
  for (const name of ['repeated', 'unrelated', 'disabled'] as const)
    expect(result[name]).not.toContain('shadow');
  expect(result.reenabled).toContain('shadow');
  expect(result.errors).toEqual([]);
});
