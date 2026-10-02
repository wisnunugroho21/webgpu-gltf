import { expect, test } from '@playwright/test';

test('entities render independent multi-node models with root transforms, shadows and safe world replacement', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Renderer, World, ModelLibrary } = await import('/src/index.ts');
    const { animatedAsset } = await import('/tests/fixtures/animated.ts');
    const { demoAsset } = await import('/src/app/demo.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message), {
      occlusionCulling: true,
    });
    const internal = renderer as any;
    const device: GPUDevice = internal.device;
    const character = animatedAsset();
    character.gltf.extensions = {
      KHR_lights_punctual: { lights: [{ type: 'directional', intensity: 2 }] },
    };
    character.gltf.nodes!.push({ extensions: { KHR_lights_punctual: { light: 0 } } });
    character.gltf.scenes![0].nodes!.push(4);
    const original = JSON.stringify(character.gltf);
    const models = new ModelLibrary();
    models.register('hero', character, 'hero.glb');
    models.register('scenery', demoAsset(), 'scenery.glb');
    const world = new World(models);
    const group = world.createEntity({ id: 'party' });
    const player = world.createEntity({
      id: 'player',
      parent: 'party',
      model: { asset: 'hero' },
      transform: { translation: [-2, 0, 0] },
      components: { health: { current: 80 } },
    });
    const npc = world.createEntity({
      id: 'npc',
      model: { asset: 'hero' },
      transform: { translation: [2, 0, 0] },
    });
    world.createEntity({
      id: 'level',
      model: { asset: 'scenery' },
      transform: { translation: [0, -2, 0], scale: [1, 1, 1] },
    });
    player.model!.animation.setPlaying(false);
    npc.model!.animation.setPlaying(false);
    player.model!.animation.select(-1);
    npc.model!.animation.select(-1);
    const dispatched: string[] = [],
      phases: string[] = [];
    let maxError = 0;
    const watch = () => {
      for (const update of internal.scene.updates)
        if (update.deformation) {
          const owner = update.pose === player.model!.pose ? 'player' : 'npc';
          const dispatch = update.deformation.dispatchBatched.bind(update.deformation);
          update.deformation.dispatchBatched = (pass: GPUComputePassEncoder) => {
            dispatched.push(`${owner}:${update.node}`);
            dispatch(pass);
          };
        }
    };
    const write = device.queue.writeBuffer.bind(device.queue);
    const create = device.createCommandEncoder.bind(device);
    const frame = async (timestamp = 0) => {
      phases.length = 0;
      dispatched.length = 0;
      if (!renderer.render(timestamp)) throw new Error('World frame failed');
      await device.queue.onSubmittedWorkDone();
      return { phases: [...phases], dispatched: [...dispatched].sort() };
    };
    const oracle = async () => {
      for (const update of internal.scene.updates)
        if (update.deformation) {
          const gpu = update.deformation;
          gpu.data.update();
          const read = device.createBuffer({
            size: gpu.outputSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          try {
            const encoder = create();
            encoder.copyBufferToBuffer(gpu.output, gpu.outputOffset, read, 0, read.size);
            device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(read.getMappedRange());
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
            read.unmap();
          } finally {
            read.destroy();
          }
        }
    };
    try {
      const instanceAllocations: { label: string; size: number }[] = [];
      const createBuffer = device.createBuffer.bind(device);
      device.createBuffer = (descriptor) => {
        if (['Static scene instances', 'World model instances'].includes(descriptor.label ?? ''))
          instanceAllocations.push({ label: descriptor.label!, size: descriptor.size });
        return createBuffer(descriptor);
      };
      const stats = await renderer.setWorld(world);
      device.createBuffer = createBuffer;
      const sharedClips =
        player.model!.resources === npc.model!.resources &&
        player.model!.pose.clips === npc.model!.pose.clips;
      const playerUpdates = internal.scene.updates.filter(
        (u: any) => u.pose === player.model!.pose,
      );
      const npcUpdates = internal.scene.updates.filter((u: any) => u.pose === npc.model!.pose);
      const sharedInputs = playerUpdates.every((a: any) => {
        const b = npcUpdates.find((u: any) => u.node === a.node);
        return (
          a.deformation.inputs.base === b.deformation.inputs.base &&
          a.deformation.inputs.targets === b.deformation.inputs.targets &&
          a.deformation.inputs.influences === b.deformation.inputs.influences &&
          a.draw.material === b.draw.material &&
          a.draw.pipeline === b.draw.pipeline &&
          a.draw.index === b.draw.index
        );
      });
      const independentOutputs = playerUpdates.every(
        (a: any) =>
          a.deformation.output !==
          npcUpdates.find((u: any) => u.node === a.node).deformation.output,
      );
      const sharedBuffers = [
        ...new Set<GPUBuffer>(
          playerUpdates.flatMap((u: any) => [
            u.deformation.inputs.base,
            u.deformation.inputs.targets,
            u.deformation.inputs.influences,
          ]),
        ),
      ];
      let sharedDestructions = 0;
      for (const buffer of sharedBuffers) {
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => {
          sharedDestructions++;
          destroy();
        };
      }
      watch();
      const localNodeCounts = world.modelInstances.map((model) => model.pose.nodes.length);
      const lightCount = internal.scene.lights.instances.length;
      const addressing = internal.scene.updates.map((u: any) => u.draw.firstInstance);
      device.queue.writeBuffer = (...args) => {
        phases.push('upload');
        write(...args);
      };
      device.createCommandEncoder = (...args) => {
        const encoder = create(...args);
        const compute = encoder.beginComputePass.bind(encoder);
        encoder.beginComputePass = (...options) => {
          phases.push('compute');
          return compute(...options);
        };
        const render = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (...options) => {
          phases.push(options[0].label ?? 'render');
          return render(...options);
        };
        return encoder;
      };
      renderer.camera.target = new Float32Array([1, 0.5, 0]);
      renderer.camera.yaw = renderer.camera.pitch = 0;
      renderer.camera.distance = 12;
      const initial = await frame();
      await oracle();
      const held = await frame();
      player.model!.setNodeOverride(1, { translation: [3, 0, 0] });
      world.update(0);
      const gameplayJoint = await frame();
      await oracle();
      player.model!.clearNodeOverride(1);
      await frame();
      group.setTransformOwner('physics');
      group.setTransform({ translation: [1, 0, 0] }, 'physics');
      // CPU simulations may update before rendering; its persistent revision keeps
      // this root change visible even though the renderer evaluates the same time.
      world.update(0);
      const moved = await frame();
      await oracle();
      const nodeWorld = player.model!.pose.nodes[3].world[12];
      group.setTransformOwner('gameplay');
      player.model!.animation.select(1);
      player.model!.animation.seek(2);
      npc.model!.animation.select(0);
      npc.model!.animation.seek(1);
      const animated = await frame();
      await oracle();
      player.setTransform({ scale: [-1, 1, 1] });
      await frame();
      await oracle();
      const skinUpdate = internal.scene.updates.find(
        (u: any) => u.pose === player.model!.pose && u.node === 0,
      );
      const mirroredSkin = skinUpdate.draw.pipeline === skinUpdate.mirrored;
      group.setTransform({ translation: [50, 0, 0] });
      const outside = await frame();
      await oracle();
      const culled = canvas.toDataURL();
      renderer.setFrustumCulling(false);
      await frame();
      const samePixels = culled === canvas.toDataURL();
      renderer.setFrustumCulling(true);
      // A failed new world cannot release the currently attached world's allocations.
      const attached = internal.scene;
      const owned = [...attached.resources.owned] as (GPUBuffer | GPUTexture)[];
      const destroys = new Map(owned.map((resource) => [resource, 0]));
      for (const resource of owned) {
        const destroy = resource.destroy.bind(resource);
        resource.destroy = () => {
          destroys.set(resource, destroys.get(resource)! + 1);
          destroy();
        };
      }
      const invalid = animatedAsset();
      invalid.gltf.materials![0].pbrMetallicRoughness!.baseColorTexture = { index: 99 };
      const badModels = new ModelLibrary();
      badModels.register('bad', invalid, 'bad.glb');
      const badWorld = new World(badModels);
      badWorld.createEntity({ id: 'bad', model: { asset: 'bad' } });
      let rejected = false;
      try {
        await renderer.setWorld(badWorld);
      } catch {
        rejected = true;
      }
      const preserved =
        internal.scene === attached && [...destroys.values()].every((count) => count === 0);
      await frame();
      world.createEntity({ id: 'spawned', model: { asset: 'hero' } });
      let membershipRejected = false;
      try {
        renderer.render(0);
      } catch {
        membershipRejected = true;
      }
      const spawned = await renderer.setWorld(world);
      await frame();
      const releasedOnce = [...destroys.values()].every((count) => count === 1);
      const retainedInputs =
        internal.scene.updates
          .filter((u: any) => u.deformation)
          .every((u: any) => sharedBuffers.includes(u.deformation.inputs.base)) &&
        sharedDestructions === 0;
      // Every entity using a shared opaque pipeline must remain in its merged list.
      const groupedDraws = new Set(
        [...internal.scene.opaque.values()].flatMap((group: any) => [...group.values()].flat()),
      ).size;
      world.destroyEntity('party');
      await renderer.setWorld(world);
      await frame();
      const remaining = world.entities.map((entity) => entity.id);
      const empty = new World();
      const emptyStats = await renderer.setWorld(empty);
      await frame();
      const emptyFrame = renderer.frameStats;
      const sharedReleasedOnce = sharedDestructions === sharedBuffers.length;
      await renderer.setAsset(demoAsset());
      await frame();
      return {
        stats,
        instanceAllocations,
        sharedInputs,
        sharedClips,
        independentOutputs,
        retainedInputs,
        sharedReleasedOnce,
        groupedDraws,
        localNodeCounts,
        lightCount,
        addressing,
        initial,
        held,
        gameplayJoint,
        moved,
        animated,
        outside,
        nodeWorld,
        mirroredSkin,
        samePixels,
        maxError,
        rejected,
        preserved,
        membershipRejected,
        spawned,
        releasedOnce,
        remaining,
        emptyStats,
        emptyFrame,
        originalUnchanged: JSON.stringify(character.gltf) === original,
        errors,
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.stats.instances).toBe(8);
  expect(result.instanceAllocations).toEqual([{ label: 'World model instances', size: 1024 }]);
  expect(
    result.sharedClips &&
      result.sharedInputs &&
      result.independentOutputs &&
      result.retainedInputs &&
      result.sharedReleasedOnce,
  ).toBe(true);
  expect(result.groupedDraws).toBe(10);
  expect(result.localNodeCounts).toEqual([5, 5, 4]);
  expect(result.lightCount).toBe(2);
  expect(new Set(result.addressing).size).toBe(8);
  expect(result.initial.dispatched).toEqual(['npc:0', 'npc:3', 'player:0', 'player:3']);
  expect(result.held.dispatched).toEqual([]);
  expect(result.gameplayJoint.dispatched).toEqual(['player:0']);
  expect(result.moved.dispatched).toEqual(['player:0']);
  expect(result.animated.dispatched).toEqual(['npc:0', 'player:0', 'player:3']);
  expect(result.outside.dispatched).toEqual(['player:0']);
  expect(result.nodeWorld).toBe(1);
  expect(result.mirroredSkin && result.samePixels && result.originalUnchanged).toBe(true);
  expect(result.maxError).toBeLessThan(0.00001);
  for (const snapshot of [result.initial, result.moved, result.animated, result.outside]) {
    expect(snapshot.phases.indexOf('compute')).toBeGreaterThan(
      snapshot.phases.lastIndexOf('upload'),
    );
    const shadow = snapshot.phases.findIndex((phase) => phase.startsWith('Shadow map'));
    expect(shadow).toBeGreaterThan(snapshot.phases.indexOf('compute'));
    expect(snapshot.phases.indexOf('Scene rendering')).toBeGreaterThan(shadow);
  }
  expect(
    result.rejected && result.preserved && result.membershipRejected && result.releasedOnce,
  ).toBe(true);
  expect(result.spawned.instances).toBe(10);
  expect(result.remaining).toEqual(['npc', 'level', 'spawned']);
  expect(result.emptyStats.instances).toBe(0);
  expect(result.emptyFrame).toEqual({ draws: 0, instances: 0, culledInstances: 0 });
});
