import { expect, test } from '@playwright/test';

test('compute output matches CPU reference across morph, skin and combined cases', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    // Vite serves the actual production modules and the shared original fixture. Numeric
    // readback is confined to this test; the viewer consumes output directly as vertices.
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { Pose } = await import('/src/gltf/animation.ts');
    const { Deformation } = await import('/src/gltf/deformation.ts');
    const { DeformationCompute, GpuDeformation } = await import('/src/renderer/deformation.ts');
    const { Resources } = await import('/src/renderer/resources.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    device.pushErrorScope('validation');
    const compute = await DeformationCompute.create(device);
    let maxError = 0;
    let compared = 0;
    const cases = [
      'combined',
      'reflection',
      'singular',
      'morph-only',
      'skin-only',
      'sparse',
      'multiple-sets',
    ];
    for (const name of cases) {
      const asset = animatedAsset();
      delete asset.gltf.animations;
      const primitive = asset.gltf.meshes[0].primitives[0];
      if (name === 'morph-only') delete asset.gltf.nodes[0].skin;
      if (name === 'skin-only') {
        delete primitive.targets;
        delete primitive.attributes.NORMAL;
        delete primitive.attributes.TANGENT;
        delete asset.gltf.meshes[0].weights;
        delete asset.gltf.nodes[0].weights;
        delete asset.gltf.nodes[3].weights;
      }
      // Exercise a real weighted blend (including translation), not only rigid vertices.
      const jointAccessor = asset.gltf.accessors[primitive.attributes.JOINTS_0];
      new Uint8Array(asset.buffers[asset.gltf.bufferViews[jointAccessor.bufferView].buffer]).set([
        0, 1, 0, 0,
      ]);
      const weightAccessor = asset.gltf.accessors[primitive.attributes.WEIGHTS_0];
      new Float32Array(asset.buffers[asset.gltf.bufferViews[weightAccessor.bufferView].buffer]).set(
        [0.25, 0.75, 0, 0],
      );
      // 69 vertices require two workgroups and exercise the final invocation bounds guard.
      const attributes = new Set<number>([
        ...Object.values(primitive.attributes),
        ...(primitive.targets ?? []).flatMap((target: Record<string, number>) =>
          Object.values(target),
        ),
      ] as number[]);
      for (const index of attributes) {
        const accessor = asset.gltf.accessors[index];
        const buffer = asset.gltf.bufferViews[accessor.bufferView].buffer;
        const source = new Uint8Array(asset.buffers[buffer]);
        const repeated = new Uint8Array(source.length * 23);
        for (let i = 0; i < 23; i++) repeated.set(source, i * source.length);
        asset.buffers[buffer] = repeated.buffer;
        asset.gltf.bufferViews[accessor.bufferView].byteLength = repeated.byteLength;
        accessor.count *= 23;
      }
      if (name === 'multiple-sets') {
        primitive.attributes.JOINTS_1 = primitive.attributes.JOINTS_0;
        primitive.attributes.WEIGHTS_1 = primitive.attributes.WEIGHTS_0;
      }
      if (name === 'sparse') {
        const target = asset.gltf.accessors[primitive.targets[0].POSITION];
        const valuesView = target.bufferView;
        delete target.bufferView;
        const buffer = asset.buffers.length;
        asset.buffers.push(new Uint8Array([2]).buffer);
        const indicesView = asset.gltf.bufferViews.length;
        asset.gltf.bufferViews.push({ buffer, byteLength: 1 });
        target.sparse = {
          count: 1,
          indices: { bufferView: indicesView, componentType: 5121 },
          values: { bufferView: valuesView, byteOffset: 24 },
        };
      }
      const pose = new Pose(asset);
      for (const node of [1, 2]) {
        const world = pose.nodes[node].world;
        world[0] = name === 'reflection' ? -2 : name === 'singular' ? 0 : 2;
        world[5] = 3;
        world[10] = 4;
        world[4] = 0.3;
        world[8] = 0.2;
        world[9] = 0.4;
        world[12] = node === 2 ? 2 : -1;
      }
      const data = new Deformation(asset, primitive, 0, pose);
      const resources = new Resources();
      const gpu = new GpuDeformation(device, resources, data, compute);
      try {
        // Dispatch repeatedly into the same buffers with opposite morph weights to catch
        // accidental accumulation and stale pose uploads; include every available attribute.
        for (const weight of [0.7, -0.4, 0.7]) {
          if (data.weights.length) pose.nodes[0].weights[0] = weight;
          pose.nodes[2].world[12] += 0.15; // the palette must refresh along with weights
          data.update();
          gpu.update();
          const readback = device.createBuffer({
            size: gpu.output.size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          try {
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            gpu.dispatch(pass);
            pass.end();
            encoder.copyBufferToBuffer(gpu.output, 0, readback, 0, gpu.output.size);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(readback.getMappedRange());
            for (const stream of data.streams) {
              const offset = { POSITION: 0, NORMAL: 4, TANGENT: 8 }[stream.semantic];
              for (let v = 0; v < gpu.count; v++)
                for (let c = 0; c < stream.width; c++) {
                  const error = Math.abs(
                    values[v * 12 + offset + c] - stream.values[v * stream.width + c],
                  );
                  if (!Number.isFinite(error)) throw new Error(`${name}: non-finite GPU output`);
                  maxError = Math.max(maxError, error);
                  compared++;
                }
            }
            readback.unmap();
          } finally {
            readback.destroy();
          }
        }
      } finally {
        resources.destroy();
      }
    }
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    return { maxError, compared, errors };
  });
  expect(result.errors).toEqual([]);
  expect(result.compared).toBeGreaterThan(10000);
  expect(result.maxError).toBeLessThan(0.00001);
});

test('shared deformation inputs feed independently weighted nodes with different skins without duplicate uploads', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { Pose } = await import('/src/gltf/animation.ts');
    const { Deformation } = await import('/src/gltf/deformation.ts');
    const { DeformationInputCache } = await import('/src/gltf/deformation-inputs.ts');
    const { DeformationCompute, GpuDeformation } = await import('/src/renderer/deformation.ts');
    const { GpuDeformationInputCache } = await import('/src/renderer/deformation-inputs.ts');
    const { Resources } = await import('/src/renderer/resources.ts');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const resources = new Resources();
    const allocations: GPUBuffer[] = [];
    const own = resources.own.bind(resources);
    resources.own = <T extends GPUBuffer | GPUTexture>(resource: T): T => {
      if (resource instanceof GPUBuffer) allocations.push(resource);
      return own(resource);
    };
    const compute = await DeformationCompute.create(device);
    const asset = animatedAsset();
    asset.gltf.nodes.push(
      { mesh: 0, skin: 1, weights: [-0.4] },
      { children: [6], translation: [-2, 0, 0] },
      { translation: [0, 1, 0] },
    );
    asset.gltf.skins.push({ joints: [5, 6] });
    asset.gltf.scenes[0].nodes.push(4, 5);
    const primitive = asset.gltf.meshes[0].primitives[0];
    primitive.attributes.JOINTS_1 = primitive.attributes.JOINTS_0;
    primitive.attributes.WEIGHTS_1 = primitive.attributes.WEIGHTS_0;
    const pose = new Pose(asset);
    const cpuCache = new DeformationInputCache(asset);
    const gpuCache = new GpuDeformationInputCache(device, resources);
    const nodes = [0, 3, 4]; // Skin + morph, morph only, and a different skin + morph.
    const data = nodes.map((node) => new Deformation(asset, primitive, node, pose, cpuCache));
    const gpu = data.map((d) => new GpuDeformation(device, resources, d, compute, gpuCache));
    const sharedVertices = gpu.every(
      (d) =>
        d.inputs.base === gpu[0].inputs.base &&
        d.inputs.targets === gpu[0].inputs.targets &&
        d.source === gpu[0].source,
    );
    const sharedInfluences = gpu[0].inputs.influences === gpu[2].inputs.influences;
    const neutralInfluences =
      gpu[1].inputs.influences !== gpu[0].inputs.influences && gpu[1].inputs.influences.size === 32;
    const independentOutputs = new Set(gpu.map((d) => d.output)).size === 3;
    const poseBuffers = gpu as unknown as { paletteBuffer: GPUBuffer; weightsBuffer: GPUBuffer }[];
    const independentPoses =
      new Set(poseBuffers.map((d) => d.paletteBuffer)).size === 3 &&
      new Set(poseBuffers.map((d) => d.weightsBuffer)).size === 3;
    const immutableAllocations = allocations.filter((buffer) =>
      ['Immutable deformation vertices', 'Morph deltas', 'Skin influences'].includes(buffer.label),
    );
    const original = [...gpu[0].source];
    let maxError = 0;
    try {
      for (const [iteration, weights] of [
        [0.6, -0.4, 0.2],
        [-0.5, 0.8, 1.1],
        [0.6, -0.4, 0.2],
      ].entries()) {
        pose.nodes[2].world[12] = iteration * 0.3;
        pose.nodes[6].world[12] = -2 - iteration * 0.7;
        data.forEach((d, i) => {
          pose.nodes[nodes[i]].weights[0] = weights[i];
          d.update();
          gpu[i].update();
        });
        const readbacks = gpu.map((d) =>
          device.createBuffer({
            size: d.output.size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          }),
        );
        try {
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          gpu.forEach((d) => d.dispatch(pass));
          pass.end();
          gpu.forEach((d, i) =>
            encoder.copyBufferToBuffer(d.output, 0, readbacks[i], 0, d.output.size),
          );
          device.queue.submit([encoder.finish()]);
          for (let i = 0; i < gpu.length; i++) {
            await readbacks[i].mapAsync(GPUMapMode.READ);
            const values = new Float32Array(readbacks[i].getMappedRange());
            for (const stream of data[i].streams) {
              const offset = { POSITION: 0, NORMAL: 4, TANGENT: 8 }[stream.semantic];
              for (let v = 0; v < gpu[i].count; v++)
                for (let c = 0; c < stream.width; c++) {
                  const error = Math.abs(
                    values[v * 12 + offset + c] - stream.values[v * stream.width + c],
                  );
                  if (!Number.isFinite(error)) throw new Error('Nonfinite output');
                  maxError = Math.max(maxError, error);
                }
            }
            readbacks[i].unmap();
          }
        } finally {
          readbacks.forEach((buffer) => buffer.destroy());
        }
      }
      const preserved = gpu[0].source.every((v, i) => v === original[i]);
      const error = await device.popErrorScope();
      return {
        sharedVertices,
        sharedInfluences,
        neutralInfluences,
        independentOutputs,
        independentPoses,
        preserved,
        immutableCount: immutableAllocations.length,
        uniqueOwnership: new Set(allocations).size === allocations.length,
        maxError,
        error: error?.message,
      };
    } finally {
      resources.destroy();
      device.destroy();
    }
  });
  expect(result.error).toBeUndefined();
  expect(result.sharedVertices && result.sharedInfluences && result.neutralInfluences).toBe(true);
  expect(
    result.independentOutputs &&
      result.independentPoses &&
      result.preserved &&
      result.uniqueOwnership,
  ).toBe(true);
  expect(result.immutableCount).toBe(4); // Base, deltas, packed influences, neutral influences.
  expect(result.maxError).toBeLessThan(0.00001);
});
