import { expect, test } from '@playwright/test';
import type { DeviceResources } from '../src/renderer/core/device-resources';

test('editing actual companion content preserves survivor outputs and restores animated membership through the renderer adapter', async ({
  page,
}) => {
  await page.goto('/browser-tests/fixtures/harness.html');
  const result = await page.evaluate(async () => {
    const { Renderer, WorldEditor } = await import('/src/index.ts');
    const { RapierPhysics } = await import('/src/engine/physics/rapier.ts');
    const { createLevel } = await import('/src/game/level.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.append(canvas);
    const physics = await RapierPhysics.create();
    const world = createLevel(physics);
    for (const model of world.modelInstances) model.animation.setPlaying(false);
    const errors: string[] = [];
    const renderer = await Renderer.create(canvas, (message) => errors.push(message));
    const gpu = Reflect.get(renderer, 'gpu') as DeviceResources;
    try {
      await renderer.setWorld(world);
      renderer.render(0);
      const player = world.getEntity('player').model!;
      const companion = world.getEntity('companion').model!;
      companion.setNodeOverride(0, { scale: [1.2, 1.2, 1.2] });
      const editor = new WorldEditor(world);
      const playerHandle = renderer.getRenderInstanceHandle(player);
      const playerDraw = gpu.scene!.world!.parts.get(player)!.data.draws[0];
      const outputs = playerDraw.vertices.map((vertex) => vertex.buffer);
      // An editor adapter owns this explicit paused CPU -> membership -> render
      // boundary. The command service has no renderer or simulation dependency.
      const publish = async (result: { membershipChanged: boolean }) => {
        world.update(0);
        if (result.membershipChanged) await renderer.syncWorld(world);
        renderer.render(0);
      };
      await publish(
        editor.execute({
          type: 'set-transform',
          id: 'companion',
          patch: { translation: [3, 0.02, 3] },
        }),
      );
      const revision = world.getEntity('companion').worldRevision;
      await publish(editor.undo());
      await publish(editor.redo());
      const playback = JSON.stringify(companion.animation.checkpoint());
      await publish(
        editor.execute({ type: 'membership', changes: [{ type: 'destroy', id: 'companion' }] }),
      );
      const removed = !world.entities.some((entity) => entity.id === 'companion');
      await publish(editor.undo());
      const restored = world.getEntity('companion').model!;
      const role = world.getEntity('companion').getComponent('game.actor');
      const survivor =
        renderer.getRenderInstanceHandle(player) === playerHandle &&
        gpu.scene!.draws.includes(playerDraw) &&
        playerDraw.vertices.every((vertex, i) => vertex.buffer === outputs[i]);
      return {
        errors,
        removed,
        survivor,
        transform: world.getEntity('companion').transform.translation,
        revised: world.getEntity('companion').worldRevision > 0 && revision > 0,
        restoredPlayback: JSON.stringify(restored.animation.checkpoint()) === playback,
        restoredOverride: restored.getNodeOverride(0).scale,
        role,
        newInstance: restored !== companion,
      };
    } finally {
      renderer.destroy();
      physics.destroy();
      world.models.destroy();
      canvas.remove();
    }
  });
  expect(result).toEqual({
    errors: [],
    removed: true,
    survivor: true,
    transform: [3, 0.02, 3],
    revised: true,
    restoredPlayback: true,
    restoredOverride: [1.2, 1.2, 1.2],
    role: { version: 1, role: 'companion' },
    newInstance: true,
  });
});
