import { expect, test } from '@playwright/test';

test('batched dispatches preserve independent outputs, dirty subsets and device-limit splitting', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { Pose } = await import('/src/scene/pose.ts');
    const { Deformation } = await import('/src/scene/deformation.ts');
    const { DeformationInputCache } = await import('/src/scene/deformation-inputs.ts');
    const { DeformationCompute } = await import('/src/renderer/deformation/compute.ts');
    const { GpuDeformation } = await import('/src/renderer/deformation/instance.ts');
    const { GpuDeformationInputCache } = await import('/src/renderer/deformation/inputs.ts');
    const { planDeformationBatches, prepareDeformationBatches } =
      await import('/src/renderer/deformation/batch.ts');
    const { Resources } = await import('/src/renderer/core/resources.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const compute = await DeformationCompute.create(device);
    const dispatches: number[][][] = [];
    let maxError = 0;
    let compared = 0;
    let untouched = true;
    let independent = true;
    let uniqueOwnership = true;
    let writesDuringEncoding = 0;
    let encoding = false;
    const write = device.queue.writeBuffer.bind(device.queue);
    device.queue.writeBuffer = (...args: Parameters<GPUQueue['writeBuffer']>) => {
      if (encoding) writesDuringEncoding++;
      write(...args);
    };
    // Exercise the actual hardware, with smaller planning limits to make splitting
    // testable without allocating hundreds of megabytes or thousands of nodes.
    for (const mode of ['normal', 'workgroups', 'storage', 'singleton', 'skin-only']) {
      const resources = new Resources();
      const owned: GPUBuffer[] = [];
      const own = resources.own.bind(resources);
      resources.own = <T extends GPUBuffer | GPUTexture>(value: T): T => {
        if (value instanceof GPUBuffer) owned.push(value);
        return own(value);
      };
      try {
        const asset = animatedAsset();
        delete asset.gltf.animations;
        asset.gltf.skins!.push({ joints: [2, 1, 3] }); // Different ordering and palette size.
        asset.gltf.nodes!.push(
          { mesh: 0, skin: 1, weights: [-0.4] },
          { mesh: 0, skin: 0, weights: [0.6] },
          { mesh: 0, skin: 1, weights: [1.1] },
          { mesh: 0, weights: [-0.2] },
          { mesh: 0, weights: [0.3] },
        );
        asset.gltf.scenes![0].nodes!.push(4, 5, 6, 7, 8);
        const primitive = asset.gltf.meshes![0].primitives[0];
        // 69 vertices require two X workgroups; the final one is partially occupied.
        const attributes = new Set<number>([
          ...Object.values(primitive.attributes),
          ...primitive.targets!.flatMap((target: Record<string, number>) => Object.values(target)),
        ] as number[]);
        for (const index of attributes) {
          const accessor = asset.gltf.accessors![index];
          const view = asset.gltf.bufferViews![accessor.bufferView!];
          const source = new Uint8Array(asset.buffers[view.buffer]);
          const repeated = new Uint8Array(source.length * 23);
          for (let i = 0; i < 23; i++) repeated.set(source, i * source.length);
          asset.buffers[view.buffer] = repeated.buffer;
          view.byteLength = repeated.byteLength;
          accessor.count *= 23;
        }
        if (mode === 'skin-only') {
          delete primitive.targets;
          delete asset.gltf.meshes![0].weights;
          for (const node of asset.gltf.nodes!) delete node.weights;
        }
        const pose = new Pose(asset);
        const cpuCache = new DeformationInputCache(asset);
        const cache = new GpuDeformationInputCache(device, resources);
        const nodes = mode === 'skin-only' ? [0, 4, 5, 6] : [0, 4, 5, 6, 3, 7, 8];
        const data = nodes.map((node) => new Deformation(asset, primitive, node, pose, cpuCache));
        const alignment = device.limits.minStorageBufferOffsetAlignment;
        const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
        const outputAlignment = (alignment / gcd(alignment, 48)) * 48;
        const outputStride = Math.ceil((69 * 48) / outputAlignment) * outputAlignment;
        const planningDevice = {
          limits: {
            minStorageBufferOffsetAlignment: alignment,
            maxComputeWorkgroupsPerDimension:
              mode === 'workgroups' ? 2 : device.limits.maxComputeWorkgroupsPerDimension,
            maxStorageBufferBindingSize:
              mode === 'storage'
                ? outputStride * 2
                : mode === 'singleton'
                  ? outputStride
                  : device.limits.maxStorageBufferBindingSize,
            maxBufferSize: device.limits.maxBufferSize,
          },
          createBuffer: device.createBuffer.bind(device),
          createBindGroup: device.createBindGroup.bind(device),
          queue: device.queue,
        } as GPUDevice;
        const slots = planDeformationBatches(planningDevice, resources, compute, cache, data);
        const gpu = data.map(
          (d) => new GpuDeformation(device, resources, d, compute, cache, slots.get(d)),
        );
        independent &&=
          new Set(gpu.map((d) => `${owned.indexOf(d.output)}:${d.outputOffset}`)).size ===
          gpu.length;
        uniqueOwnership &&= new Set(owned).size === owned.length;
        let previous: Float32Array[] = [];
        for (const iteration of [0, 1, 2]) {
          // Select nonadjacent members, including the last arena slice. Neighbors must
          // retain their output even though their buffer participates in the dispatch.
          const pending = iteration === 0 ? gpu : iteration === 1 ? gpu.slice(3, 5) : [];
          if (iteration === 1) {
            for (const d of pending) {
              if (d.data.weights.length) pose.nodes[d.data.node].weights[0] = -0.8;
              d.data.update();
              d.update();
            }
          }
          prepareDeformationBatches(pending);
          const encoder = device.createCommandEncoder();
          const calls: number[][] = [];
          if (pending.length) {
            encoding = true;
            const pass = encoder.beginComputePass();
            const dispatch = pass.dispatchWorkgroups.bind(pass);
            pass.dispatchWorkgroups = (x, y = 1, z = 1) => {
              calls.push([x, y]);
              dispatch(x, y, z);
            };
            pending.forEach((d) => d.dispatchBatched(pass));
            pass.end();
            encoding = false;
          }
          dispatches.push(calls);
          const readbacks = gpu.map((d) =>
            device.createBuffer({
              size: d.outputSize,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }),
          );
          try {
            gpu.forEach((d, i) =>
              encoder.copyBufferToBuffer(d.output, d.outputOffset, readbacks[i], 0, d.outputSize),
            );
            device.queue.submit([encoder.finish()]);
            const current: Float32Array[] = [];
            for (let i = 0; i < gpu.length; i++) {
              await readbacks[i].mapAsync(GPUMapMode.READ);
              const values = new Float32Array(readbacks[i].getMappedRange()).slice();
              current.push(values);
              if (iteration && !pending.includes(gpu[i]))
                untouched &&= values.every((v, j) => v === previous[i][j]);
              for (const stream of data[i].streams) {
                const offset = { POSITION: 0, NORMAL: 4, TANGENT: 8 }[stream.semantic];
                for (let v = 0; v < gpu[i].count; v++)
                  for (let c = 0; c < stream.width; c++) {
                    const error = Math.abs(
                      values[v * 12 + offset + c] - stream.values[v * stream.width + c],
                    );
                    if (!Number.isFinite(error)) throw new Error('Non-finite batched output');
                    maxError = Math.max(maxError, error);
                    compared++;
                  }
              }
              readbacks[i].unmap();
            }
            previous = current;
          } finally {
            readbacks.forEach((buffer) => buffer.destroy());
          }
        }
      } finally {
        resources.destroy();
      }
    }
    const validation = await device.popErrorScope();
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    return {
      dispatches,
      maxError,
      compared,
      untouched,
      independent,
      uniqueOwnership,
      writesDuringEncoding,
      error: validation?.message,
    };
  });
  expect(result.error).toBeUndefined();
  expect(result.maxError).toBeLessThan(0.00001);
  expect(result.compared).toBeGreaterThan(50000);
  expect(result.untouched && result.independent && result.uniqueOwnership).toBe(true);
  expect(result.writesDuringEncoding).toBe(0);
  expect(result.dispatches).toEqual([
    [
      [2, 4],
      [2, 3],
    ],
    [
      [2, 1],
      [2, 1],
    ],
    [],
    [
      [2, 2],
      [2, 2],
      [2, 2],
      [2, 1],
    ],
    [
      [2, 1],
      [2, 1],
    ],
    [],
    [
      [2, 2],
      [2, 2],
      [2, 2],
      [2, 1],
    ],
    [
      [2, 1],
      [2, 1],
    ],
    [],
    Array.from({ length: 7 }, () => [2, 1]),
    [
      [2, 1],
      [2, 1],
    ],
    [],
    [[2, 4]],
    [[2, 1]],
    [],
  ]);
});
