import { expect, test } from '@playwright/test';
import type { Scene } from '../src/renderer/scene/types';

test('world synchronization retains private output and slots, grows once, and rolls back failed additions', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const device = testDevice(renderer);
    const allocations: { buffer: GPUBuffer; label: string; destroys: number }[] = [];
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = (descriptor) => {
      const buffer = createBuffer({
        ...descriptor,
        usage:
          descriptor.usage |
          (descriptor.label === 'World model instances' ? GPUBufferUsage.COPY_SRC : 0),
      });
      const record = { buffer, label: descriptor.label ?? '', destroys: 0 };
      allocations.push(record);
      const destroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => {
        record.destroys++;
        destroy();
      };
      return buffer;
    };
    const models = new ModelLibrary();
    models.register('hero', animatedAsset(), 'hero.glb');
    const world = new World(models);
    const spawn = (id: string, x: number) => {
      const entity = world.createEntity({
        id,
        model: { asset: 'hero' },
        transform: { translation: [x, 0, 0] },
      });
      entity.model!.animation.select(-1);
      entity.model!.animation.setPlaying(false);
      return entity.model!;
    };
    const a = spawn('a', -2),
      b = spawn('b', 0);
    const scene = () => Reflect.get(Reflect.get(renderer, 'gpu'), 'scene') as Scene;
    const frame = async () => {
      world.update(0);
      if (!renderer.render(0)) throw new Error('Frame failed');
      await device.queue.onSubmittedWorkDone();
    };
    const read = async (source: GPUBuffer, offset: number, size: number) => {
      const destination = createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(source, offset, destination, 0, size);
        device.queue.submit([encoder.finish()]);
        await destination.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(destination.getMappedRange()).slice();
        destination.unmap();
        return values;
      } finally {
        destination.destroy();
      }
    };
    let maxError = 0;
    const oracle = async () => {
      for (const update of scene().updates)
        if (update.deformation) {
          const gpu = update.deformation;
          gpu.data.update();
          const values = await read(gpu.output, gpu.outputOffset, gpu.outputSize);
          for (const stream of gpu.data.streams) {
            const offset = ({ POSITION: 0, NORMAL: 4, TANGENT: 8 } as Record<string, number>)[
              stream.semantic
            ];
            for (let v = 0; v < gpu.count; v++)
              for (let c = 0; c < stream.width; c++)
                maxError = Math.max(
                  maxError,
                  Math.abs(values[v * 12 + offset + c] - stream.values[v * stream.width + c]),
                );
          }
        }
    };
    const outputs = (model: typeof a) => [
      ...new Set(
        scene()
          .updates.filter((u) => u.pose === model.pose)
          .flatMap((u) => (u.deformation ? [u.deformation.output] : [])),
      ),
    ];
    const destructions = (buffers: GPUBuffer[]) =>
      buffers.map((buffer) => allocations.find((record) => record.buffer === buffer)!.destroys);
    let survivors = false,
      reused = false,
      held = false,
      failedPreserved = false,
      noWritesOnFailure = false,
      releaseOnlyRemoved = false,
      growth = false,
      noOp = false,
      empty = false;
    try {
      world.update(0);
      await renderer.setWorld(world);
      await frame();
      await oracle();
      const firstBuffer = scene().transformBuffer;
      const aHandle = renderer.getRenderInstanceHandle(a)!,
        bHandle = renderer.getRenderInstanceHandle(b)!;
      const aOutputs = outputs(a),
        bOutputs = outputs(b);
      const aRevision = a.pose.revision;
      const c = spawn('c', 2);
      world.update(0);
      await renderer.syncWorld(world);
      const grownBuffer = scene().transformBuffer;
      const cHandle = renderer.getRenderInstanceHandle(c)!;
      const cOutputs = outputs(c);
      growth =
        firstBuffer !== grownBuffer &&
        renderer.getRenderInstanceHandle(a) === aHandle &&
        allocations.find((record) => record.buffer === firstBuffer)!.destroys === 1;
      await frame();
      await oracle();
      // Reclaim b's range in a candidate, then fail after preparing its replacement.
      world.destroyEntity('b');
      const replacement = spawn('replacement', 0);
      const bad = animatedAsset();
      bad.gltf.materials![0].pbrMetallicRoughness!.baseColorTexture = { index: 99 };
      models.register('bad', bad, 'bad.glb');
      world.createEntity({ id: 'bad', model: { asset: 'bad' } });
      world.update(0);
      const attached = scene();
      const before = await read(grownBuffer, 0, grownBuffer.size);
      let writes = 0;
      const write = device.queue.writeBuffer.bind(device.queue);
      device.queue.writeBuffer = (...args) => {
        if (args[0] === grownBuffer) writes++;
        write(...args);
      };
      let rejected = false;
      try {
        await renderer.syncWorld(world);
      } catch {
        rejected = true;
      }
      device.queue.writeBuffer = write;
      const after = await read(grownBuffer, 0, grownBuffer.size);
      failedPreserved =
        rejected &&
        scene() === attached &&
        destructions(aOutputs.concat(bOutputs, cOutputs)).every((n) => n === 0);
      noWritesOnFailure = writes === 0 && before.every((value, i) => value === after[i]);
      world.destroyEntity('bad');
      world.update(0);
      await renderer.syncWorld(world);
      const replacementHandle = renderer.getRenderInstanceHandle(replacement)!;
      reused =
        scene().transformBuffer === grownBuffer &&
        replacementHandle.firstInstance === bHandle.firstInstance &&
        replacementHandle.id !== bHandle.id &&
        renderer.getRenderInstanceHandle(b) === undefined;
      survivors =
        renderer.getRenderInstanceHandle(a) === aHandle &&
        renderer.getRenderInstanceHandle(c) === cHandle &&
        outputs(a).every((buffer, i) => buffer === aOutputs[i]) &&
        outputs(c).every((buffer, i) => buffer === cOutputs[i]) &&
        a.pose.revision === aRevision;
      releaseOnlyRemoved =
        destructions(bOutputs).every((n) => n === 1) &&
        destructions(aOutputs.concat(cOutputs)).every((n) => n === 0);
      let dispatched = 0,
        poseWrites = 0;
      const activeUpdates = scene().updates.filter((u) => u.pose === a.pose || u.pose === c.pose);
      for (const update of activeUpdates)
        if (update.deformation) {
          const gpu = update.deformation,
            dispatch = gpu.dispatchBatched.bind(gpu);
          gpu.dispatchBatched = (pass) => {
            dispatched++;
            dispatch(pass);
          };
        }
      await frame();
      await oracle(); // Only the new replacement needs initial compute.
      held = dispatched === 0;
      const current = scene(),
        allocationCount = allocations.length;
      const camera = Array.from(renderer.camera.target);
      await renderer.syncWorld(world);
      noOp =
        scene() === current &&
        allocations.length === allocationCount &&
        Array.from(renderer.camera.target).every((v, i) => v === camera[i]);
      device.queue.writeBuffer = (...args) => {
        if (
          args[0] === grownBuffer ||
          [
            'Batched joint palettes',
            'Batched morph weights',
            'Joint palette',
            'Morph weights',
          ].includes(args[0].label)
        )
          poseWrites++;
        write(...args);
      };
      await frame();
      device.queue.writeBuffer = write;
      held &&= poseWrites === 0;
      a.setNodeOverride(1, { translation: [3, 0, 0] });
      await frame();
      await oracle(); // Retained private outputs remain mutable.
      world.applyChanges(world.entities.map((entity) => ({ type: 'destroy', id: entity.id })));
      world.update(0);
      await renderer.syncWorld(world);
      await frame();
      empty =
        renderer.frameStats.instances === 0 &&
        scene().transformBuffer.size === 128 &&
        destructions(aOutputs.concat(cOutputs)).every((n) => n === 1);
    } finally {
      renderer.destroy();
      canvas.remove();
    }
    return {
      survivors,
      reused,
      held,
      failedPreserved,
      noWritesOnFailure,
      releaseOnlyRemoved,
      growth,
      noOp,
      empty,
      maxError,
      allReleasedOnce: allocations.every((record) => record.destroys === 1),
      detachedOnDestroy: renderer.getRenderInstanceHandle(a) === undefined,
      errors,
    };
  });
  expect(result.errors).toEqual([]);
  for (const key of [
    'survivors',
    'reused',
    'held',
    'failedPreserved',
    'noWritesOnFailure',
    'releaseOnlyRemoved',
    'growth',
    'noOp',
    'empty',
    'allReleasedOnce',
    'detachedOnDestroy',
  ] as const)
    expect(result[key], key).toBe(true);
  expect(result.maxError).toBeLessThan(0.00001);
});

test('a delayed visibility readback cannot apply to a reused membership slot', async ({ page }) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const { testDevice } = await import('/browser-tests/helpers/inspect.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      occlusionCulling: true,
      frustumCulling: false,
      shadows: false,
    });
    const device = testDevice(renderer);
    const models = new ModelLibrary();
    models.register('cubes', demoAsset(), 'cubes.glb');
    const world = new World(models);
    world.createEntity({
      id: 'front',
      model: { asset: 'cubes' },
      transform: { translation: [0, 0, 2], scale: [2, 2, 0.2] },
    });
    const rear = world.createEntity({
      id: 'rear',
      model: { asset: 'cubes' },
      transform: { translation: [0, 0, -4] },
    });
    const occlusion = Reflect.get(
      Reflect.get(renderer, 'gpu'),
      'occlusion',
    ) as import('/src/renderer/scene/occlusion.ts').OcclusionCulling;
    const wait = async () => {
      for (let i = 0; occlusion.stats.pending && i < 1000; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      if (occlusion.stats.pending) throw new Error('Occlusion readback did not settle');
    };
    let release: (() => void) | undefined;
    try {
      world.update(0);
      await renderer.setWorld(world);
      renderer.camera.target = new Float32Array([0, 0, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 16;
      renderer.render(0);
      await device.queue.onSubmittedWorkDone();
      await wait();
      const readback = Reflect.get(occlusion, 'readback') as GPUBuffer;
      if (!readback) throw new Error('No visibility query buffer');
      const map = readback.mapAsync.bind(readback);
      const gate = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      readback.mapAsync = (...args) => map(...args).then(() => gate);
      renderer.setOcclusionCulling(true);
      renderer.render(0);
      await device.queue.onSubmittedWorkDone();
      const pending = renderer.occlusionStats.pending;
      const oldHandle = renderer.getRenderInstanceHandle(rear.model!)!;
      const beforeDiscarded = renderer.occlusionStats.discardedResults;
      world.destroyEntity('rear');
      const fresh = world.createEntity({
        id: 'fresh',
        model: { asset: 'cubes' },
        transform: { translation: [4, 0, 0] },
      });
      world.update(0);
      await renderer.syncWorld(world);
      const nextHandle = renderer.getRenderInstanceHandle(fresh.model!)!;
      renderer.render(0); // Held old query must fail open for the new membership.
      await device.queue.onSubmittedWorkDone();
      const submitted = renderer.frameStats.instances;
      readback.mapAsync = map;
      release!();
      await wait();
      const staleIgnored =
        renderer.occlusionStats.knownInstances === 0 &&
        renderer.occlusionStats.discardedResults > beforeDiscarded;
      return {
        pending,
        submitted,
        staleIgnored,
        reused:
          nextHandle.firstInstance === oldHandle.firstInstance && nextHandle.id !== oldHandle.id,
        errors,
      };
    } finally {
      release?.();
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.pending && result.reused && result.staleIgnored).toBe(true);
  expect(result.submitted).toBe(8);
});
