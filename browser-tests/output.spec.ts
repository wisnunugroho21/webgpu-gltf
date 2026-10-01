import { expect, test } from '@playwright/test';

test('HDR retains highlights and blends in linear space before exposure and presentation', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { OutputPass, hdrFormat } = await import('/src/renderer/presentation/output.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({
      code: /* wgsl */ `
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fragment() -> @location(0) vec4f { return vec4f(4.0, 0.5, 0.25, 0.5); }
`,
    });
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
    });
    const samples: number[][] = [];
    const invalid: string[] = [];
    for (const format of ['rgba8unorm', 'rgba8unorm-srgb'] as const) {
      const output = await OutputPass.create(device, format);
      output.resize(2, 2);
      output.resize(1, 1); // resizing must replace the HDR texture and sampled bind group
      const target = device.createTexture({
        format,
        size: [1, 1],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      try {
        for (const settings of [
          { toneMapping: 'reinhard', exposureEV: 0 },
          { toneMapping: 'none', exposureEV: -2 },
          { toneMapping: 'none', exposureEV: 0 },
        ] as const) {
          output.setSettings(settings);
          const readback = device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          try {
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: output.view,
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: [0.25, 0.5, 1, 1],
                },
              ],
            });
            pass.setPipeline(pipeline);
            pass.draw(3);
            pass.end();
            // Expected linear blend: [2.125, 0.5, 0.625]. An LDR or sRGB blend cannot
            // produce these values; lower exposure must reveal the unclipped highlight.
            output.encode(encoder, target.createView());
            encoder.copyTextureToBuffer(
              { texture: target },
              { buffer: readback, bytesPerRow: 256 },
              [1, 1],
            );
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            samples.push([...new Uint8Array(readback.getMappedRange()).slice(0, 4)]);
            readback.unmap();
          } finally {
            readback.destroy();
          }
        }
        const before = output.settings;
        for (const exposureEV of [NaN, Infinity, -17, 17]) {
          try {
            output.setSettings({ exposureEV });
          } catch (error) {
            invalid.push(String(error));
          }
        }
        if (JSON.stringify(output.settings) !== JSON.stringify(before))
          throw new Error('Invalid exposure changed output state');
      } finally {
        output.destroy();
        target.destroy();
      }
    }
    const error = await device.popErrorScope();
    device.destroy();
    return { samples, invalid: invalid.length, error: error?.message };
  });
  expect(result.error).toBeUndefined();
  expect(result.invalid).toBe(8);
  const srgb = (value: number) =>
    Math.round(
      Math.min(1, value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255,
    );
  const radiance = [2.125, 0.5, 0.625];
  const expected = [
    radiance.map((value) => srgb(value / (1 + value))),
    radiance.map((value) => srgb(value * 0.25)),
    radiance.map(srgb),
  ];
  result.samples.forEach((sample, i) => {
    sample
      .slice(0, 3)
      .forEach((value, c) => expect(Math.abs(value - expected[i % 3][c])).toBeLessThanOrEqual(1));
    expect(sample[3]).toBe(255);
  });
});

test('exposure and tone controls change presentation without changing scene pipelines', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.locator('#stats')).toContainText('4 primitive instances');
  const stats = await page.locator('#stats').innerText();
  const before = await page.locator('canvas').screenshot();
  await page.locator('#exposure').evaluate((input) => {
    (input as HTMLInputElement).value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#exposure-value')).toHaveText('2.0 EV');
  const bright = await page.locator('canvas').screenshot();
  expect(bright.equals(before)).toBe(false);
  await page.locator('#tone-mapping').selectOption('none');
  const clipped = await page.locator('canvas').screenshot();
  expect(clipped.equals(bright)).toBe(false);
  await expect(page.locator('#stats')).toHaveText(stats);
  await page.setViewportSize({ width: 950, height: 700 });
  await page.locator('canvas').screenshot({ path: 'test-results/hdr-output.png' });
  expect(errors).toEqual([]);
});
