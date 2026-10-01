import { expect, test } from '@playwright/test';

test('MSAA resolves fractional geometry coverage and transparent HDR blending before tone mapping', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { OutputPass, hdrFormat } = await import('/src/renderer/output.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({
      code: /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array<vec2f, 3>(vec2f(-0.9, -0.85), vec2f(0.8, -0.6), vec2f(-0.55, 0.9));
  return vec4f(points[index], 0.2, 1.0);
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(4.0, 0.5, 0.25, 0.5); }
`,
    });
    const width = 32,
      height = 24;
    const images: number[][] = [];
    let rejected = false;
    try {
      await OutputPass.create(device, 'rgba8unorm', 2 as 1);
    } catch {
      rejected = true;
    }
    for (const sampleCount of [1, 4] as const) {
      const output = await OutputPass.create(device, 'rgba8unorm', sampleCount);
      output.resize(37, 27);
      output.resize(width, height); // Both HDR attachments must resize together.
      const depth = device.createTexture({
        size: [width, height],
        sampleCount,
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const target = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const readback = device.createBuffer({
        size: height * 256,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      try {
        const pipeline = await device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [
              {
                format: hdrFormat,
                blend: {
                  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                },
              },
            ],
          },
          depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
          multisample: { count: sampleCount },
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [output.sceneAttachment([0.25, 0.5, 1, 1])],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
          },
        });
        pass.setPipeline(pipeline);
        pass.draw(3);
        pass.end();
        output.encode(encoder, target.createView());
        encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [
          width,
          height,
        ]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(readback.getMappedRange());
        const pixels: number[] = [];
        for (let y = 0; y < height; y++) pixels.push(...bytes.slice(y * 256, y * 256 + width * 4));
        images.push(pixels);
        readback.unmap();
      } finally {
        output.destroy();
        depth.destroy();
        target.destroy();
        readback.destroy();
      }
    }
    const error = await device.popErrorScope();
    device.destroy();
    return { images, rejected, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  expect(result.rejected).toBe(true);
  const display = (linear: number) => {
    const mapped = linear / (1 + linear);
    return Math.round(
      (mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - 0.055) * 255,
    );
  };
  // At covered samples transparency blends first: [2.125, 0.5, 0.625]. Resolve
  // averages that with uncovered background, THEN applies the nonlinear curve.
  const background = [0.25, 0.5, 1],
    covered = [2.125, 0.5, 0.625];
  const expected = Array.from({ length: 5 }, (_, n) =>
    background.map((v, c) => display(v + ((covered[c] - v) * n) / 4)),
  );
  const coverageSets = result.images.map((pixels) => {
    const counts = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      const errors = expected.map((color) =>
        Math.max(...color.map((v, c) => Math.abs(v - pixels[i + c]))),
      );
      const closest = errors.indexOf(Math.min(...errors));
      expect(errors[closest]).toBeLessThanOrEqual(2);
      expect(pixels[i + 3]).toBe(255);
      counts.add(closest);
    }
    return [...counts].sort();
  });
  expect(coverageSets[0]).toEqual([0, 4]);
  expect(coverageSets[1]).toContain(0);
  expect(coverageSets[1]).toContain(4);
  expect(coverageSets[1].some((n) => n > 0 && n < 4)).toBe(true);
});

test('renderer supports explicit single-sample mode and defaults to four samples across model replacement and resize', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const { demoAsset } = await import('/src/demo.ts');
    const errors: string[] = [];
    const samples: number[] = [];
    for (const options of [{ sampleCount: 1 as const }, {}]) {
      const canvas = document.createElement('canvas');
      canvas.style.width = '200px';
      canvas.style.height = '150px';
      document.body.append(canvas);
      const renderer = await Renderer.create(canvas, (message) => errors.push(message), options);
      try {
        samples.push(renderer.sampleCount);
        await renderer.setAsset(demoAsset());
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        canvas.style.width = '123px';
        canvas.style.height = '117px';
        await renderer.setAsset(demoAsset());
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      } finally {
        renderer.destroy();
        canvas.remove();
      }
    }
    return { errors, samples };
  });
  expect(result.errors).toEqual([]);
  expect(result.samples).toEqual([1, 4]);
});
