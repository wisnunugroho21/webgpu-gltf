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
import { loadSaveState, type SaveState } from '../engine/serialization/save-state';
import { GameTools } from './tools';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const status = document.querySelector<HTMLElement>('#status')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const companionButton = document.querySelector<HTMLButtonElement>('#companion')!;

async function start(): Promise<void> {
  pauseButton.disabled = companionButton.disabled = true;
  let restored: SaveState | undefined;
  const pending = sessionStorage.getItem('engine-game-pending');
  if (pending) {
    sessionStorage.removeItem('engine-game-pending');
    restored = JSON.parse(pending) as SaveState;
  }
  const physics = await RapierPhysics.create();
  let renderer: Renderer | undefined;
  let world: World;
  let levelResources: World['models'] | undefined;
  try {
    world = createLevel(physics);
    levelResources = world.models;
    if (restored) world = (await loadSaveState(restored, { assets: world.models })).world;
  } catch (error) {
    physics.destroy();
    levelResources?.destroy();
    throw error;
  }
  const input = new ActionInput(),
    camera = new FollowCamera();
  let player: ReturnType<World['getEntity']>;
  let simulation: CharacterSimulation;
  try {
    player = world.getEntity('player');
    simulation = new CharacterSimulation(world, physics, input);
    // Publish initial colliders to Rapier's query structures before movement.
    physics.step(1 / 60);
    if (restored) {
      // Systems are reconstructed first, then durable instance state overrides their defaults.
      const gameplay = restored.gameplay as unknown as {
        body: ReturnType<NonNullable<typeof simulation.body.checkpoint>>;
        footfalls: number;
        rootMotion: boolean;
        locomotion: 'Idle' | 'Walk' | 'Run';
      };
      if (
        !gameplay ||
        !Number.isSafeInteger(gameplay.footfalls) ||
        gameplay.footfalls < 0 ||
        typeof gameplay.rootMotion !== 'boolean' ||
        !['Idle', 'Walk', 'Run'].includes(gameplay.locomotion)
      )
        throw new Error('Invalid saved character gameplay.');
      simulation.body.restore!(gameplay.body);
      simulation.footfalls = gameplay.footfalls;
      simulation.rootMotionEnabled = gameplay.rootMotion;
      simulation.locomotion.state = gameplay.locomotion;
      player.model!.animation.restore(restored.models.player.animation);
      simulation.restorePolicy();
      document.querySelector<HTMLInputElement>('#root-motion')!.checked = gameplay.rootMotion;
    }
  } catch (error) {
    physics.destroy();
    world.models.destroy();
    throw error;
  }
  let tools: GameTools | undefined;
  let runtime: EngineRuntime | undefined,
    raf = 0,
    disposed = false,
    busy = false;
  let manuallyPaused = restored?.runtime?.paused ?? false,
    companion = world.entities.some((entity) => entity.id === 'companion'),
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
    tools?.destroy();
    world.models.destroy();
  };
  const fail = (error: unknown) => {
    status.textContent = `Game stopped: ${error instanceof Error ? error.message : String(error)}`;
    pauseButton.disabled = companionButton.disabled = true;
    cleanup();
  };
  try {
    renderer = await Renderer.create(canvas, (message) => fail(new Error(message)), {
      memoryProfiling: true,
      cpuProfiling: true,
      gpuProfiling: true,
      onDeviceLost: (message) => {
        busy = true;
        runtime?.pause();
        input.clear();
        tools?.setPaused(true);
        status.textContent = `${message} Reconnecting...`;
        void renderer!
          .recover()
          .then(() => {
            if (disposed) return;
            busy = false;
            if (!manuallyPaused && !document.hidden) {
              runtime?.resume();
              tools?.setPaused(false);
            }
          })
          .catch(fail);
      },
    });
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
          // Only the player's footfalls drive gameplay; discard companion events
          // instead of retaining an unused queue for the lifetime of the level.
          for (const model of world.modelInstances)
            if (model !== player.model) model.animation.drainEvents();
          const p = player.worldMatrix;
          const dt = Math.max(0, (frame.presentationTimeMs - lastPresentation) / 1000);
          lastPresentation = frame.presentationTimeMs;
          camera.update([p[12], p[13] + 1, p[14]], dt);
          tools?.update(camera);
          if (!renderer!.render(frame.presentationTimeMs, camera.view(renderer!.aspectRatio)))
            return;
          status.textContent = frame.paused
            ? 'Paused'
            : `${simulation.locomotion.state} · ${simulation.body.grounded ? 'Grounded' : 'Airborne'}`;
          if (!frame.paused) status.textContent += ` · ${simulation.footfalls} footfalls`;
        },
      },
      { systems: simulation.systems },
    );
    if (restored?.runtime) runtime.restore(restored.runtime);
    tools = new GameTools(world, runtime, renderer, simulation, () => busy || disposed);
    const pausePolicy = () => {
      input.clear();
      if (manuallyPaused || document.hidden || busy) runtime!.pause();
      else runtime!.resume();
      tools?.setPaused(manuallyPaused || document.hidden || busy);
      pauseButton.textContent = manuallyPaused ? 'Resume' : 'Pause';
    };
    unbind = bindKeyboard(input);
    const options = { signal: events.signal };
    document.querySelector<HTMLInputElement>('#root-motion')!.addEventListener(
      'change',
      (event) => {
        simulation.rootMotionEnabled = (event.target as HTMLInputElement).checked;
        input.clear();
        canvas.focus();
      },
      options,
    );
    companionButton.textContent = companion ? 'Despawn companion' : 'Spawn companion';
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
