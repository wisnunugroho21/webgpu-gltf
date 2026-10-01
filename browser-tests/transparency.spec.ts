import { expect, test } from '@playwright/test';

test('weighted transparency is stable across intersecting draw/triangle order, opacity and resize in single-sample and MSAA modes', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    type Asset = import('../src/gltf/types').Asset;
    const asset = (
      reverse = false,
      oneMesh = false,
      alpha = 0.5,
      occluder = false,
      hdr = false,
    ): Asset => {
      const a: Asset = {
        gltf: {
          asset: { version: '2.0' },
          buffers: [],
          bufferViews: [],
          accessors: [],
          meshes: [],
          nodes: [],
          scenes: [{ nodes: [] }],
          scene: 0,
          materials: [],
        },
        buffers: [],
        images: [],
        warnings: [],
      };
      const add = (values: number[], type: string, indices = false) => {
        const array = indices ? new Uint16Array(values) : new Float32Array(values);
        const buffer = a.buffers.length;
        a.buffers.push(array.buffer);
        a.gltf.buffers!.push({ byteLength: array.byteLength });
        const view = a.gltf.bufferViews!.length;
        a.gltf.bufferViews!.push({ buffer, byteLength: array.byteLength });
        const index = a.gltf.accessors!.length;
        a.gltf.accessors!.push({
          bufferView: view,
          componentType: indices ? 5123 : 5126,
          type,
          count: values.length / (type === 'VEC3' ? 3 : type === 'VEC4' ? 4 : 1),
        });
        return index;
      };
      const red = [-1, -1, -0.5, 1, -1, 0.5, 0, 1, 0];
      const blue = [-1, -1, 0.5, 1, -1, -0.5, 0, 1, 0];
      const material = (color: number[], opacity: number, opaque = false) => {
        const index = a.gltf.materials!.length;
        a.gltf.materials!.push({
          alphaMode: opaque ? 'OPAQUE' : 'BLEND',
          doubleSided: true,
          pbrMetallicRoughness: {
            baseColorFactor: [...color, opacity],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
          extensions: hdr
            ? { KHR_materials_emissive_strength: { emissiveStrength: 512 } }
            : { KHR_materials_unlit: {} },
          emissiveFactor: hdr ? [1, 0.25, 0.125] : undefined,
        });
        return index;
      };
      const mesh = (
        position: number[],
        color: number[],
        opacity: number,
        vertexColor?: number[],
        opaque = false,
      ) => {
        const meshIndex = a.gltf.meshes!.length;
        const attributes: Record<string, number> = {
          POSITION: add(position, 'VEC3'),
          NORMAL: add(
            Array(position.length / 3)
              .fill([0, 0, 1])
              .flat(),
            'VEC3',
          ),
        };
        if (vertexColor) attributes.COLOR_0 = add(vertexColor, 'VEC4');
        a.gltf.meshes!.push({
          primitives: [
            {
              attributes,
              material: material(color, opacity, opaque),
              ...(oneMesh && !opaque
                ? {
                    indices: add(reverse ? [3, 4, 5, 0, 1, 2] : [0, 1, 2, 3, 4, 5], 'SCALAR', true),
                  }
                : {}),
            },
          ],
        });
        a.gltf.nodes!.push({ mesh: meshIndex });
        a.gltf.scenes![0].nodes.push(meshIndex);
      };
      if (oneMesh)
        mesh([...red, ...blue], [1, 1, 1], 1, [
          ...Array(3).fill([1, 0, 0, alpha]).flat(),
          ...Array(3).fill([0, 0, 1, alpha]).flat(),
        ]);
      else {
        mesh(red, hdr ? [0, 0, 0] : [1, 0, 0], alpha);
        if (!hdr) mesh(blue, [0, 0, 1], alpha);
        if (reverse) a.gltf.meshes!.reverse(); // Same geometry/materials, opposite primitive submission order.
      }
      if (occluder) mesh([-1.5, -1.5, 1, 1.5, -1.5, 1, 0, 1.5, 1], [0, 1, 0], 1, undefined, true);
      return a;
    };
    const half = (bits: number) => {
      const exponent = (bits >> 10) & 31,
        fraction = bits & 1023;
      return (
        (bits & 32768 ? -1 : 1) *
        (exponent === 0
          ? (2 ** -14 * fraction) / 1024
          : exponent === 31
            ? Infinity
            : 2 ** (exponent - 15) * (1 + fraction / 1024))
      );
    };
    const errors: string[] = [];
    const cases: {
      samples: number;
      mode: string;
      orderError: number;
      triangleError: number;
      center: number[];
      occluded: number[];
      zero: number[];
      hdr: number[];
      lifetime: number[];
    }[] = [];
    for (const samples of [1, 4] as const)
      for (const mode of ['weighted', 'sorted'] as const) {
        const canvas = document.createElement('canvas');
        canvas.style.width = canvas.style.height = '32px';
        document.body.append(canvas);
        const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
          sampleCount: samples,
          transparency: mode,
          shadows: false,
          frustumCulling: false,
        });
        const internal = renderer as unknown as {
          device: GPUDevice;
          output: { texture: GPUTexture };
          scene: import('../src/renderer/scene/types').Scene;
        };
        renderer.setEnvironment({ intensity: 0 });
        const textures = new Map<GPUTexture, number>();
        const create = internal.device.createTexture.bind(internal.device);
        internal.device.createTexture = (descriptor) => {
          const texture = create(descriptor);
          if (descriptor.label?.startsWith('Transparency ')) {
            textures.set(texture, 0);
            const destroy = texture.destroy.bind(texture);
            texture.destroy = () => {
              textures.set(texture, textures.get(texture)! + 1);
              destroy();
            };
          }
          return texture;
        };
        const read = async () => {
          renderer.camera.target.set([0, 0, 0]);
          renderer.camera.radius = 1;
          renderer.camera.distance = 4;
          renderer.camera.pitch = renderer.camera.yaw = 0;
          renderer.render(0);
          const texture = internal.output.texture;
          const row = Math.ceil((texture.width * 8) / 256) * 256;
          const buffer = internal.device.createBuffer({
            size: row * texture.height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          try {
            const encoder = internal.device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [
              texture.width,
              texture.height,
            ]);
            internal.device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const words = new Uint16Array(buffer.getMappedRange());
            const values: number[] = [];
            for (let y = 0; y < texture.height; y++)
              for (let x = 0; x < texture.width * 4; x++)
                values.push(half(words[(y * row) / 2 + x]));
            buffer.unmap();
            return values;
          } finally {
            buffer.destroy();
          }
        };
        const frame = async (a: Asset) => {
          await renderer.setAsset(a);
          return read();
        };
        const difference = (a: number[], b: number[]) =>
          Math.max(...a.map((v, i) => Math.abs(v - b[i])));
        const center = (image: number[]) => image.slice((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4);
        let record: (typeof cases)[number];
        try {
          const original = await frame(asset());
          const reversed = await frame(asset(true));
          const triangles = await frame(asset(false, true));
          const trianglesReversed = await frame(asset(true, true));
          const occluded = await frame(asset(false, false, 0.5, true));
          const zero = await frame(asset(false, false, 0));
          const faint = await frame(asset(false, false, 0.001));
          const faintCoverage = 1 - 0.999 ** 2;
          const faintRed = 0.5 * faintCoverage + 0.001935 * (1 - faintCoverage);
          if (Math.abs(center(faint)[0] - faintRed) > 0.00003)
            throw new Error('Low-opacity LDR transparency lost its contribution');
          const hdr = await frame(asset(false, false, 0.5, false, true));
          const hdrOpaque = await frame(asset(false, false, 1, false, true));
          const tiny = await frame(asset(false, false, 0.001, false, true));
          const tinyExpected = center(hdrOpaque)[0] * 0.001 + 0.001935 * 0.999;
          if (Math.abs(center(tiny)[0] - tinyExpected) > 0.03)
            throw new Error(
              `Low-opacity HDR transparency lost its contribution: ${samples}/${mode}: ${center(tiny)[0]} vs ${tinyExpected}`,
            );
          // Single translucent HDR layer must reduce to ordinary OVER, including MSAA.
          const expected = hdrOpaque[(16 * 32 + 16) * 4] * 0.5 + 0.001935 * 0.5;
          if (Math.abs(center(hdr)[0] - expected) > 0.5)
            throw new Error('HDR transparency lost radiance');
          const beforeStats = renderer.frameStats;
          const before = await read();
          renderer.setOutput({ exposureEV: -2 });
          if (difference(before, await read()) !== 0)
            throw new Error('Tone mapping changed linear OIT output');
          canvas.style.width = '40px';
          canvas.style.height = '28px';
          await read();
          await renderer.setAsset(asset());
          const old = internal.scene;
          const bad = asset();
          bad.gltf.materials![0].pbrMetallicRoughness!.baseColorTexture = { index: 99 };
          let rejected = false;
          try {
            await renderer.setAsset(bad);
          } catch {
            rejected = true;
          }
          if (!rejected || internal.scene !== old)
            throw new Error('Failed scene replaced working transparency');
          if (beforeStats.instances < 1 || renderer.transparencyMode !== mode)
            throw new Error('Invalid transparency state');
          record = {
            samples,
            mode,
            orderError: difference(original, reversed),
            triangleError: difference(triangles, trianglesReversed),
            center: center(original),
            occluded: center(occluded),
            zero: center(zero),
            hdr: center(hdr),
            lifetime: [],
          };
        } finally {
          renderer.destroy();
          canvas.remove();
        }
        record!.lifetime = [...textures.values()];
        cases.push(record!);
      }
    let rejected = false;
    try {
      await Renderer.create(document.createElement('canvas'), () => {}, {
        transparency: 'invalid' as 'weighted',
      });
    } catch {
      rejected = true;
    }
    return { cases, errors, rejected };
  });
  expect(result.errors).toEqual([]);
  expect(result.rejected).toBe(true);
  for (const entry of result.cases) {
    expect(entry.hdr[0]).toBeGreaterThan(200);
    expect(entry.occluded).toEqual([0, 1, 0, 1]);
    expect(Math.abs(entry.zero[0] - 0.001935)).toBeLessThan(0.00001);
    expect(entry.lifetime.every((count) => count === 1)).toBe(true);
    if (entry.mode === 'weighted') {
      expect(entry.orderError).toBeLessThan(0.005);
      expect(entry.triangleError).toBeLessThan(0.005);
      expect(entry.center[0]).toBeCloseTo(0.375, 2);
      expect(entry.center[2]).toBeCloseTo(0.375, 2);
      expect(entry.lifetime).toHaveLength(4); // Two attachments, each resized once.
    } else {
      expect(entry.orderError).toBeGreaterThan(0.1);
      expect(entry.triangleError).toBeGreaterThan(0.1);
      expect(entry.lifetime).toHaveLength(0);
    }
  }
});

test('weighted transparency composites per MSAA sample before HDR resolve, including different layer coverage', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { OutputPass } = await import('/src/renderer/presentation/output.ts');
    const { TransparencyPass } = await import('/src/renderer/render/transparency.ts');
    const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
    device.pushErrorScope('validation');
    const results: { samples: number; pixels: number[] }[] = [];
    const half = (v: number) => {
      const e = (v >> 10) & 31,
        f = v & 1023;
      return e === 0 ? (2 ** -14 * f) / 1024 : e === 31 ? Infinity : 2 ** (e - 15) * (1 + f / 1024);
    };
    for (const samples of [1, 4] as const) {
      const output = await OutputPass.create(device, 'rgba8unorm', samples);
      output.resize(32, 24);
      const oit = await TransparencyPass.create(device, samples);
      oit.resize(32, 24);
      const depth = device.createTexture({
        format: 'depth24plus',
        size: [32, 24],
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const buffer = device.createBuffer({
        size: 256 * 24,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const pipelines: GPURenderPipeline[] = [];
        for (const blue of [false, true]) {
          const module = device.createShaderModule({
            code: /* wgsl */ `
struct Out { @location(0) accumulation: vec4f, @location(1) revealage: f32 }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = ${blue ? 'array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3))' : 'array<vec2f, 3>(vec2f(-0.9,-0.85), vec2f(0.8,-0.6), vec2f(-0.55,0.9))'};
  return vec4f(p[index], 0.2, 1);
}
@fragment fn fragment() -> Out {
  var result: Out;
  result.accumulation = vec4f(${blue ? '0.0, 0.0, 0.5 / 256.0' : '0.5 / 256.0, 0.0, 0.0'}, 0.5);
  result.revealage = log(2.0); return result;
}`,
          });
          pipelines.push(
            await device.createRenderPipelineAsync({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertex' },
              fragment: {
                module,
                entryPoint: 'fragment',
                targets: [
                  {
                    format: 'rgba16float',
                    blend: {
                      color: { srcFactor: 'one', dstFactor: 'one' },
                      alpha: { srcFactor: 'one', dstFactor: 'one' },
                    },
                  },
                  {
                    format: 'r16float',
                    blend: {
                      color: { srcFactor: 'one', dstFactor: 'one' },
                      alpha: { srcFactor: 'one', dstFactor: 'one' },
                    },
                  },
                ],
              },
              depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less',
              },
              multisample: { count: samples },
            }),
          );
        }
        const encoder = device.createCommandEncoder();
        const background = encoder.beginRenderPass({
          colorAttachments: [output.sceneAttachment([0.25, 0.5, 1, 1], 'clear', true)],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        background.end();
        const pass = oit.begin(encoder, depth);
        for (const pipeline of pipelines) {
          pass.setPipeline(pipeline);
          pass.draw(3);
        }
        pass.end();
        oit.composite(encoder, output);
        const hdr = (output as unknown as { texture: GPUTexture }).texture;
        encoder.copyTextureToBuffer({ texture: hdr }, { buffer, bytesPerRow: 256 }, [32, 24]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        results.push({ samples, pixels: [...new Uint16Array(buffer.getMappedRange())].map(half) });
        buffer.unmap();
      } finally {
        buffer.destroy();
        depth.destroy();
        oit.destroy();
        output.destroy();
      }
    }
    const error = await device.popErrorScope();
    device.destroy();
    return { results, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  for (const entry of result.results) {
    let edges = 0;
    for (let i = 0; i < entry.pixels.length; i += 4) {
      const [r, g, b, alpha] = entry.pixels.slice(i, i + 4);
      const coverage = (r - 0.125) / (0.4375 - 0.125);
      const expectedCoverage = Math.round(coverage * entry.samples) / entry.samples;
      expect(Math.abs(coverage - expectedCoverage)).toBeLessThan(0.002);
      expect(Math.abs(g - (0.25 - 0.125 * expectedCoverage))).toBeLessThan(0.001);
      expect(Math.abs(b - (1 - 0.375 * expectedCoverage))).toBeLessThan(0.001);
      expect(alpha).toBe(1);
      if (coverage > 0.01 && coverage < 0.99) edges++;
    }
    if (entry.samples === 4) expect(edges).toBeGreaterThan(10);
    else expect(edges).toBe(0);
  }
});
