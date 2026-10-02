import './style.css';
import { ActionInput } from '../engine/input/actions';
import { RapierPhysics } from '../engine/physics/rapier';
import { EngineRuntime } from '../engine/runtime/runtime';
import { FollowCamera } from '../engine/camera/follow-camera';
import { Renderer } from '../renderer/renderer';
import { bindKeyboard } from './keyboard';
import { addCompanion, createLevel } from './level';
import { CharacterSimulation } from './simulation';
import type { World } from '../engine/world';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const status = document.querySelector<HTMLElement>('#status')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const companionButton = document.querySelector<HTMLButtonElement>('#companion')!;

async function start(): Promise<void> {
  const physics = await RapierPhysics.create();
  let renderer: Renderer | undefined;
  let world: World;
  try {
    world = createLevel(physics);
  } catch (error) {
    physics.destroy();
    throw error;
  }
  const input = new ActionInput(),
    camera = new FollowCamera();
  const player = world.getEntity('player');
  let simulation: CharacterSimulation;
  try {
    simulation = new CharacterSimulation(world, physics, input);
    // Publish initial colliders to Rapier's query structures before movement.
    physics.step(1 / 60);
  } catch (error) {
    physics.destroy();
    world.models.destroy();
    throw error;
  }
  let runtime: EngineRuntime | undefined,
    raf = 0,
    disposed = false,
    busy = false;
  let manuallyPaused = false,
    companion = true,
    lastPresentation = 0;
  const events = new AbortController();
  let unbind = () => {};
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    events.abort();
    unbind();
    runtime?.destroy();
    simulation.destroy();
    physics.destroy();
    renderer?.destroy();
    world.models.destroy();
  };
  const fail = (error: unknown) => {
    status.textContent = `Game stopped: ${error instanceof Error ? error.message : String(error)}`;
    pauseButton.disabled = companionButton.disabled = true;
    cleanup();
  };
  try {
    renderer = await Renderer.create(canvas, (message) => fail(new Error(message)));
    if (disposed) {
      renderer.destroy();
      return;
    }
    await renderer.setWorld(world);
    if (disposed) return;
    runtime = new EngineRuntime(
      world,
      {
        present(frame) {
          const p = player.worldMatrix;
          const dt = Math.max(0, (frame.presentationTimeMs - lastPresentation) / 1000);
          lastPresentation = frame.presentationTimeMs;
          camera.update([p[12], p[13] + 1, p[14]], dt);
          if (!renderer!.render(frame.presentationTimeMs, camera.view(renderer!.aspectRatio)))
            return;
          status.textContent = frame.paused
            ? 'Paused'
            : `${simulation.locomotion.state} · ${simulation.body.grounded ? 'Grounded' : 'Airborne'}`;
        },
      },
      { systems: simulation.systems },
    );
    const pausePolicy = () => {
      input.clear();
      if (manuallyPaused || document.hidden || busy) runtime!.pause();
      else runtime!.resume();
      pauseButton.textContent = manuallyPaused ? 'Resume' : 'Pause';
    };
    unbind = bindKeyboard(input);
    const options = { signal: events.signal };
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', () => canvas.focus(), options);
    pauseButton.addEventListener(
      'click',
      () => {
        manuallyPaused = !manuallyPaused;
        pausePolicy();
        canvas.focus();
      },
      options,
    );
    document.addEventListener('visibilitychange', pausePolicy, options);
    window.addEventListener('pagehide', cleanup, options);
    companionButton.addEventListener(
      'click',
      () => {
        if (busy || disposed) return;
        busy = true;
        companionButton.disabled = true;
        pausePolicy();
        // Renderer membership preparation is asynchronous. Stop all submissions until
        // it commits; surviving player poses, slots and deformation buffers are retained.
        void (async () => {
          try {
            if (companion) world.destroyEntity('companion');
            else addCompanion(world);
            world.updateTransforms();
            await renderer!.syncWorld(world);
            if (disposed) return;
            companion = !companion;
            companionButton.textContent = companion ? 'Despawn companion' : 'Spawn companion';
            busy = false;
            companionButton.disabled = false;
            pausePolicy();
            canvas.focus();
          } catch (error) {
            fail(error);
          }
        })();
      },
      options,
    );
    const tick = (timestamp: number) => {
      if (disposed) return;
      try {
        if (!busy) runtime!.advance(timestamp);
      } catch (error) {
        fail(error);
        return;
      }
      if (!disposed) raf = requestAnimationFrame(tick);
    };
    pauseButton.disabled = companionButton.disabled = false;
    pausePolicy();
    raf = requestAnimationFrame(tick);
    if (import.meta.hot) import.meta.hot.dispose(cleanup);
  } catch (error) {
    fail(error);
  }
}

void start().catch((error: unknown) => {
  status.textContent = `Unable to start: ${error instanceof Error ? error.message : String(error)}`;
});
