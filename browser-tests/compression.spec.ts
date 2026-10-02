import { expect, test } from '@playwright/test';

test('meshopt placeholder buffers decode skins, morphs and animation before GPU preparation', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { MeshoptEncoder } = await import('/node_modules/meshoptimizer/meshopt_encoder.js');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { loadFiles, Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { decodeAccessor } = await import('/src/gltf/accessors.ts');
    await MeshoptEncoder.ready;
    const template = animatedAsset();
    const gltf = template.gltf;
    const original = structuredClone(gltf);
    const encoded: Uint8Array<ArrayBuffer>[] = [];
    // Each original view becomes a meshopt stream. Integer joints use four-byte records.
    for (const view of gltf.bufferViews!) {
      const accessor = gltf.accessors!.find(
        (a) => a.bufferView === gltf.bufferViews!.indexOf(view),
      )!;
      const width = ({ SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[
        accessor.type
      ];
      const stride = width * (accessor.componentType === 5121 ? 1 : 4);
      const bytes = MeshoptEncoder.encodeGltfBuffer(
        new Uint8Array(template.buffers[view.buffer]),
        accessor.count,
        stride,
        'ATTRIBUTES',
      );
      const buffer = encoded.length;
      encoded.push(new Uint8Array(bytes));
      view.buffer = 0;
      view.extensions = {
        EXT_meshopt_compression: {
          buffer: buffer + 1,
          byteLength: bytes.length,
          byteStride: stride,
          count: accessor.count,
          mode: 'ATTRIBUTES',
        },
      };
    }
    gltf.buffers = [
      { byteLength: 1024, extensions: { EXT_meshopt_compression: { fallback: true } } },
      ...encoded.map((bytes, i) => ({ uri: `stream${i}.bin`, byteLength: bytes.length })),
    ];
    gltf.extensionsRequired = ['EXT_meshopt_compression'];
    const files = () => [
      new File([JSON.stringify(gltf)], 'model.gltf'),
      ...encoded.map((bytes, i) => new File([bytes], `stream${i}.bin`)),
    ];
    await loadFiles(files());
    // The fallback tag is optional: URI-less placeholders must work without it too.
    delete gltf.buffers![0].extensions;
    const asset = await loadFiles(files());
    const equal = original.accessors!.every(
      (accessor, i) =>
        JSON.stringify(decodeAccessor({ ...template, gltf: original }, accessor)) ===
        JSON.stringify(decodeAccessor(asset, asset.gltf.accessors![i])),
    );
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
    };
    try {
      await renderer.setAsset(asset);
      renderer.animation.setPlaying(false);
      renderer.animation.seek(1);
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      return { equal, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.equal).toBe(true);
  expect(result.errors).toEqual([]);
});

test('Draco required assets decode in the worker and render normalized integer colors', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { loadUrl, Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { decodeAccessor } = await import('/src/gltf/accessors.ts');
    const asset = await loadUrl('/tests/fixtures/compression/quad-draco.gltf');
    const primitive = asset.gltf.meshes![0].primitives[0];
    const colors = decodeAccessor(asset, asset.gltf.accessors![primitive.attributes.COLOR_0]);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
    };
    try {
      renderer.setOutput({ toneMapping: 'none' });
      await renderer.setAsset(asset);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.distance = 4;
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderViewerFrame(renderer, 0);
      await internal.device.queue.onSubmittedWorkDone();
      const image = new Image();
      image.src = canvas.toDataURL();
      await image.decode();
      const read = document.createElement('canvas');
      read.width = read.height = 160;
      const ctx = read.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return { colors, pixel: [...ctx.getImageData(80, 80, 1, 1).data], errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.colors).toEqual(
    Array.from({ length: 4 }, () => [128 / 255, 1, 64 / 255, 1]).flat(),
  );
  expect(result.pixel[0]).toBeGreaterThan(180);
  expect(result.pixel[1]).toBe(255);
  expect(result.pixel[2]).toBeGreaterThan(130);
  expect(result.errors).toEqual([]);
});

test('ETC1S and UASTC KTX2 retain mipmaps and match PNG in color and data slots', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/viewer/index.html');
  const result = await page.evaluate(async () => {
    const { loadFiles, Renderer } = await import('/src/index.ts');
    const { renderViewerFrame } = await import('/browser-tests/fixtures/viewer/app/frame.ts');
    const { materialAsset } = await import('/tests/fixtures/material.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:160px;height:160px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const internal = Reflect.get(renderer, 'gpu') as unknown as {
      device: GPUDevice;
    };
    renderer.setEnvironment({ intensity: 0 });
    renderer.setOutput({ toneMapping: 'none' });
    const pixel = async (asset: Awaited<ReturnType<typeof loadFiles>>) => {
      await renderer.setAsset(asset);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.distance = 4;
      renderer.camera.yaw = renderer.camera.pitch = 0;
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
    const pairs = [];
    try {
      for (const name of ['2d_etc1s.ktx2', '2d_uastc.ktx2']) {
        const bytes = await (await fetch(`/tests/fixtures/compression/${name}`)).arrayBuffer();
        for (const color of [true, false]) {
          const material = color
            ? {
                pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
                extensions: { KHR_materials_unlit: {} },
              }
            : {
                pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.5, 1], metallicFactor: 0 },
                extensions: {
                  KHR_materials_specular: {
                    specularTexture: { index: 0 },
                    specularColorTexture: { index: 0 },
                  },
                },
              };
          const template = materialAsset(material);
          const gltf = template.gltf;
          gltf.buffers = template.buffers.map((buffer, index) => ({
            byteLength: buffer.byteLength,
            uri: `mesh${index}.bin`,
          }));
          gltf.images = [{ uri: name, mimeType: 'image/ktx2' }];
          gltf.textures = [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }];
          gltf.samplers = [{ minFilter: 9728, magFilter: 9728 }];
          gltf.extensionsRequired = ['KHR_texture_basisu'];
          let files: File[];
          if (name === '2d_etc1s.ktx2' && color) {
            // Embed geometry and KTX2 in a GLB to exercise bufferView-backed images.
            const sources = [...template.buffers, bytes];
            const offsets: number[] = [];
            let total = 0;
            for (const source of sources) {
              offsets.push(total);
              total += Math.ceil(source.byteLength / 4) * 4;
            }
            const bin = new Uint8Array(total);
            sources.forEach((source, i) => bin.set(new Uint8Array(source), offsets[i]));
            for (const view of gltf.bufferViews!) {
              view.byteOffset = (view.byteOffset ?? 0) + offsets[view.buffer];
              view.buffer = 0;
            }
            const imageView =
              gltf.bufferViews!.push({
                buffer: 0,
                byteOffset: offsets[2],
                byteLength: bytes.byteLength,
              }) - 1;
            gltf.images = [{ bufferView: imageView, mimeType: 'image/ktx2' }];
            gltf.buffers = [{ byteLength: total }];
            const json = new TextEncoder().encode(JSON.stringify(gltf));
            const jsonLength = Math.ceil(json.length / 4) * 4;
            const glb = new Uint8Array(28 + jsonLength + total);
            const header = new DataView(glb.buffer);
            header.setUint32(0, 0x46546c67, true);
            header.setUint32(4, 2, true);
            header.setUint32(8, glb.length, true);
            header.setUint32(12, jsonLength, true);
            header.setUint32(16, 0x4e4f534a, true);
            glb.fill(32, 20, 20 + jsonLength);
            glb.set(json, 20);
            header.setUint32(20 + jsonLength, total, true);
            header.setUint32(24 + jsonLength, 0x004e4942, true);
            glb.set(bin, 28 + jsonLength);
            files = [new File([glb], 'model.glb')];
          } else
            files = [
              new File([JSON.stringify(gltf)], 'model.gltf'),
              ...template.buffers.map((buffer, index) => new File([buffer], `mesh${index}.bin`)),
              new File([bytes], name),
            ];
          const asset = await loadFiles(files);
          const levels = asset.decodedImages!.get(0)!.levels;
          const base = levels[0];
          const pngCanvas = document.createElement('canvas');
          pngCanvas.width = base.width;
          pngCanvas.height = base.height;
          pngCanvas
            .getContext('2d')!
            .putImageData(
              new ImageData(new Uint8ClampedArray(base.data), base.width, base.height),
              0,
              0,
            );
          const blob = await new Promise<Blob>((resolve) =>
            pngCanvas.toBlob((value) => resolve(value!)),
          );
          const compressed = await pixel(asset);
          const plain = { ...asset, images: [blob], decodedImages: undefined };
          const png = await pixel(plain);
          pairs.push({ name, color, compressed, png, levels: levels.length });
        }
      }
      return { pairs, errors };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  for (const pair of result.pairs) {
    expect(pair.levels).toBeGreaterThan(1);
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(pair.compressed[c] - pair.png[c]),
        `${pair.name} color=${pair.color}`,
      ).toBeLessThanOrEqual(2);
  }
  expect(result.errors).toEqual([]);
});
