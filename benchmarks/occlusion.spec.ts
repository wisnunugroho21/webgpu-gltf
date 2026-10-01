import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('measure query cost and history reuse in moving scenes', async ({ page }) => {
  await page.goto('/');
  const report = await page.evaluate(async () => {
    const { Renderer } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const original = GPUAdapter.prototype.requestDevice;
    // Timing is opt-in in this benchmark, never an application requirement.
    GPUAdapter.prototype.requestDevice = function (descriptor = {}) {
      const requiredFeatures = [...(descriptor.requiredFeatures ?? [])];
      if (this.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
      return original.call(this, { ...descriptor, requiredFeatures });
    };
    const rows = [];
    const errors: string[] = [];
    let adapterInfo = {};
    try {
      for (const count of [128, 2048, 8192]) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:320px;height:240px';
        document.body.append(canvas);
        const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
          sampleCount: 1,
          shadows: false,
        });
        const internal = renderer as any;
        internal.stop();
        const device: GPUDevice = internal.device;
        const info = device.adapterInfo;
        adapterInfo = {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        };
        const timestamp = device.features.has('timestamp-query');
        const querySet = timestamp
          ? device.createQuerySet({ type: 'timestamp', count: 2 })
          : undefined;
        const resolve = timestamp
          ? device.createBuffer({
              size: 16,
              usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            })
          : undefined;
        const read = timestamp
          ? device.createBuffer({
              size: 16,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            })
          : undefined;
        const createEncoder = device.createCommandEncoder.bind(device);
        let queries = 0;
        device.createCommandEncoder = (descriptor) => {
          const encoder = createEncoder(descriptor);
          const begin = encoder.beginRenderPass.bind(encoder),
            finish = encoder.finish.bind(encoder);
          let timed = false;
          encoder.beginRenderPass = (descriptor) => {
            if (descriptor.label !== 'Occlusion queries') return begin(descriptor);
            queries = internal.occlusion.ids.length;
            timed = timestamp;
            return begin({
              ...descriptor,
              ...(querySet
                ? {
                    timestampWrites: {
                      querySet,
                      beginningOfPassWriteIndex: 0,
                      endOfPassWriteIndex: 1,
                    },
                  }
                : {}),
            });
          };
          encoder.finish = (descriptor) => {
            if (timed) {
              encoder.resolveQuerySet(querySet!, 0, 2, resolve!, 0);
              encoder.copyBufferToBuffer(resolve!, 0, read!, 0, 16);
            }
            return finish(descriptor);
          };
          return encoder;
        };
        const makeAsset = (mode: string) => {
          const asset = demoAsset();
          asset.gltf.nodes = [{ mesh: 1, scale: [4, 4, 0.1], translation: [0, 0, 1] }];
          for (let i = 0; i < count; i++)
            asset.gltf.nodes.push({
              mesh: 0,
              scale: [0.03, 0.03, 0.03],
              translation: [
                (i % 64) * 0.04 - 1.3,
                (Math.floor(i / 64) % 32) * 0.04 - 0.6,
                -1 - Math.floor(i / 2048) * 0.1,
              ],
            });
          let animated = asset.gltf.nodes.push({}) - 1;
          if (mode === 'transparent') {
            asset.gltf.materials!.push({
              alphaMode: 'BLEND',
              pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.2] },
            });
            asset.gltf.meshes!.push({
              primitives: [{ ...asset.gltf.meshes![0].primitives[0], material: 2 }],
            });
            asset.gltf.nodes[animated] = {
              mesh: 2,
              scale: [0.1, 0.1, 0.1],
              translation: [0, 0, -2],
            };
          }
          if (mode === 'occluder') animated = 0;
          if (mode !== 'static' && mode !== 'camera') {
            const input = new Float32Array([0, 2]),
              output = new Float32Array([
                0,
                0,
                mode === 'occluder' ? 1 : -2,
                0.3,
                0,
                mode === 'occluder' ? 1 : -2,
              ]);
            const accessors = [];
            for (const [data, type] of [
              [input, 'SCALAR'],
              [output, 'VEC3'],
            ] as const) {
              const buffer = asset.buffers.push(data.buffer) - 1;
              asset.gltf.buffers!.push({ byteLength: data.byteLength });
              const bufferView =
                asset.gltf.bufferViews!.push({ buffer, byteLength: data.byteLength }) - 1;
              accessors.push(
                asset.gltf.accessors!.push({ bufferView, componentType: 5126, type, count: 2 }) - 1,
              );
            }
            asset.gltf.animations = [
              {
                samplers: [{ input: accessors[0], output: accessors[1] }],
                channels: [{ sampler: 0, target: { node: animated, path: 'translation' } }],
              },
            ];
          }
          asset.gltf.scenes = [{ nodes: asset.gltf.nodes.map((_, i) => i) }];
          return asset;
        };
        try {
          for (const mode of ['static', 'unrelated', 'transparent', 'occluder', 'camera']) {
            await renderer.setAsset(makeAsset(mode));
            renderer.setPlaying(false);
            renderer.camera.target.set([0, 0, 0]);
            renderer.camera.yaw = renderer.camera.pitch = 0;
            renderer.camera.distance = 6;
            for (const enabled of [false, true]) {
              renderer.setOcclusionCulling(enabled);
              const cpu = [],
                completed = [],
                gpu = [],
                instances = [],
                queryCounts = [];
              for (let frame = 0; frame < 24; frame++) {
                if (mode === 'camera') renderer.camera.yaw = 0.01 * frame;
                else if (mode !== 'static') renderer.seek(frame * 0.025);
                queries = 0;
                const start = performance.now();
                internal.render(frame * 25);
                internal.stop();
                const encoded = performance.now() - start;
                await device.queue.onSubmittedWorkDone();
                for (let i = 0; internal.occlusion.pending && i < 500; i++)
                  await new Promise((resolve) => setTimeout(resolve, 0));
                let queryMs: number | null = timestamp ? 0 : null;
                if (timestamp && queries) {
                  await read!.mapAsync(GPUMapMode.READ);
                  const times = new BigUint64Array(read!.getMappedRange());
                  queryMs = Number(times[1] - times[0]) / 1e6;
                  read!.unmap();
                }
                if (frame >= 8) {
                  cpu.push(encoded);
                  completed.push(performance.now() - start);
                  gpu.push(queryMs);
                  instances.push(renderer.frameStats.instances);
                  queryCounts.push(queries);
                }
              }
              const percentile = (values: number[], p: number) =>
                [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
              rows.push({
                count,
                mode,
                enabled,
                cpuMedianMs: percentile(cpu, 0.5),
                cpuP95Ms: percentile(cpu, 0.95),
                completionMedianMs: percentile(completed, 0.5),
                queryGpuMedianMs: timestamp ? percentile(gpu as number[], 0.5) : null,
                instances: percentile(instances, 0.5),
                queries: percentile(queryCounts, 0.5),
              });
            }
          }
        } finally {
          querySet?.destroy();
          resolve?.destroy();
          read?.destroy();
          renderer.destroy();
          canvas.remove();
        }
      }
      return { adapterInfo, samples: 16, warmup: 8, viewport: [320, 240], msaa: 1, rows, errors };
    } finally {
      GPUAdapter.prototype.requestDevice = original;
    }
  });
  expect(report.errors).toEqual([]);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/occlusion-benchmark.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
