import { ActionInput } from '../engine/input/actions';
import { AssetRegistry } from '../engine/assets/registry';
import type { CheckpointPhysicsAdapter } from '../engine/physics/contracts';
import { browserGameBackends, type GameBackends } from './backends';
import { EngineRuntime } from '../engine/runtime/runtime';
import type { World } from '../engine/world';
import { Renderer } from '../renderer/renderer';
import { GameControls, type GameElements } from './controls';
import { addCompanion, createLevelWorld, installLevelCollisions } from './level';
import { CharacterSimulation } from './simulation';
import { GamePresentation } from './presentation';
import { readPendingSave, restoreGameWorld, restoreCharacter } from './restore';
import { GameTools } from './tools';

// HMR can remount a canvas while startup or recovery is awaiting GPU work.
// Release a canceled candidate's context before configuring its successor; late
// teardown must not unconfigure the successor's canvas.
const canvasPreparation = new WeakMap<HTMLCanvasElement, Promise<void>>();

/** Application lifetime, not an engine system. A session can be destroyed even
 * while startup awaits WASM/GPU work; late resources are released on arrival. */
export class GameSession {
  private input = new ActionInput();
  private events = new AbortController();
  private physics?: CheckpointPhysicsAdapter;
  private assets?: AssetRegistry;
  private world?: World;
  private simulation?: CharacterSimulation;
  private renderer?: Renderer;
  private runtime?: EngineRuntime;
  private tools?: GameTools;
  private presentation?: GamePresentation;
  private controls?: GameControls;
  private raf = 0;
  private started = false;
  private ready = false;
  private disposed = false;
  private manuallyPaused = false;
  private companion = false;
  // Membership preparation and recovery may overlap; completing one operation
  // must not resume submissions while the other still owns the pause boundary.
  private operations = new Set<'membership' | 'recovery'>();
  private get busy(): boolean {
    return this.operations.size > 0;
  }
  constructor(
    private view: GameElements,
    private backends: GameBackends = browserGameBackends,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.disposed) throw new Error('Game session can only start once.');
    this.started = true;
    this.view.pause.disabled = this.view.companion.disabled = true;
    try {
      // Install lifetime cancellation before the first asynchronous initialization.
      window.addEventListener('pagehide', () => this.destroy(), { signal: this.events.signal });
      const pending = readPendingSave((message) => {
        this.view.saveStatus.textContent = message;
      });
      this.physics = this.accept(await this.backends.createPhysics());
      this.assets = new AssetRegistry(this.backends.assets);
      const initial = createLevelWorld(this.assets);
      const restored = pending === undefined ? undefined : await restoreGameWorld(pending, initial);
      this.ensureActive();
      const world = (this.world = restored?.world ?? initial);
      installLevelCollisions(world, this.physics, restored?.legacyBoxes);
      const simulation = (this.simulation = new CharacterSimulation(
        world,
        this.physics,
        this.input,
      ));
      this.physics.step(1 / 60); // Publish colliders before character queries.
      if (restored) restoreCharacter(simulation, world, restored);
      this.view.rootMotion.checked = simulation.rootMotionEnabled;
      this.manuallyPaused = restored?.runtime?.paused ?? false;
      this.companion = world.entities.some((entity) => entity.id === 'companion');
      await this.attachRenderer();
      this.ensureActive();
      const renderer = this.renderer!;
      await renderer.setWorld(world);
      this.ensureActive();
      const presentation = (this.presentation = new GamePresentation(
        world,
        simulation,
        renderer,
        this.view.status,
      ));
      const runtime = (this.runtime = new EngineRuntime(
        world,
        { present: (frame) => this.presentation?.present(frame) },
        { systems: simulation.systems },
      ));
      if (restored?.runtime) runtime.restore(restored.runtime);
      this.tools = new GameTools(
        world,
        runtime,
        renderer,
        simulation,
        () => this.busy || this.disposed,
        () => this.backends.createAudio(),
      );
      presentation.tools = this.tools;
      this.controls = new GameControls(this.view, this.input, {
        pause: () => {
          this.manuallyPaused = !this.manuallyPaused;
          this.pausePolicy();
        },
        companion: () => {
          void this.toggleCompanion();
        },
        rootMotion: (enabled) => {
          simulation.rootMotionEnabled = enabled;
        },
        visibility: () => this.pausePolicy(),
      });
      this.controls.bind();
      this.ready = true;
      this.pausePolicy();
      this.raf = requestAnimationFrame(this.tick);
    } catch (error) {
      if (!this.disposed) this.view.status.textContent = `Unable to start: ${this.message(error)}`;
      try {
        this.destroy();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Game startup and cleanup failed.');
      }
      throw error;
    }
  }
  private ensureActive(): void {
    if (this.disposed) throw new Error('Game session was disposed during startup.');
  }
  private attachRenderer(): Promise<void> {
    const canvas = this.view.canvas;
    const pending = (canvasPreparation.get(canvas) ?? Promise.resolve()).then(async () => {
      this.ensureActive();
      this.renderer = this.accept(
        await Renderer.create(canvas, (message) => this.fail(new Error(message)), {
          memoryProfiling: true,
          cpuProfiling: true,
          gpuProfiling: true,
          onDeviceLost: (message) => {
            void this.recover(message);
          },
        }),
      );
    });
    canvasPreparation.set(
      canvas,
      pending.then(
        () => {},
        () => {},
      ),
    );
    return pending;
  }
  private accept<T extends { destroy(): void }>(resource: T): T {
    if (this.disposed) {
      resource.destroy();
      this.ensureActive();
    }
    return resource;
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    this.view.status.textContent = `Game stopped: ${this.message(error)}`;
    try {
      this.destroy();
    } catch (cleanup) {
      this.view.status.textContent += ` Cleanup failed: ${this.message(cleanup)}`;
    }
  }
  private pausePolicy(): void {
    if (this.disposed) return;
    this.input.clear();
    const paused = this.manuallyPaused || document.hidden || this.busy;
    if (paused) this.runtime?.pause();
    else this.runtime?.resume();
    this.tools?.setPaused(paused);
    this.controls?.update(this.manuallyPaused, this.companion, !this.ready, this.busy);
  }
  private async recover(message: string): Promise<void> {
    if (this.disposed || this.operations.has('recovery')) return;
    const renderer = this.renderer;
    if (!renderer) {
      this.fail(new Error(message));
      return;
    }
    this.operations.add('recovery');
    this.pausePolicy();
    this.view.status.textContent = `${message} Reconnecting...`;
    try {
      const pending = renderer.recover();
      canvasPreparation.set(
        this.view.canvas,
        pending.then(
          () => {},
          () => {},
        ),
      );
      await pending;
    } catch (error) {
      this.fail(error);
    } finally {
      this.operations.delete('recovery');
      this.pausePolicy();
    }
  }
  private async toggleCompanion(): Promise<void> {
    if (this.busy || this.disposed || !this.ready) return;
    this.operations.add('membership');
    this.pausePolicy();
    try {
      if (this.companion) this.world!.destroyEntity('companion');
      else addCompanion(this.world!);
      this.world!.updateTransforms();
      await this.renderer!.syncWorld(this.world!);
      if (this.disposed) return;
      this.companion = !this.companion;
      this.view.canvas.focus();
    } catch (error) {
      this.fail(error);
    } finally {
      this.operations.delete('membership');
      this.pausePolicy();
    }
  }
  private tick = (timestamp: number): void => {
    if (this.disposed) return;
    try {
      if (!this.busy) this.runtime!.advance(timestamp);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (!this.disposed) this.raf = requestAnimationFrame(this.tick);
  };
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.view.pause.disabled = this.view.companion.disabled = true;
    const failures: unknown[] = [];
    // One teardown path for normal stop, startup failure, pagehide and HMR.
    // Runtime may already own simulation destruction; its explicit fallback is
    // idempotent and also handles failure before systems have initialized.
    for (const release of [
      () => cancelAnimationFrame(this.raf),
      () => this.events.abort(),
      () => this.controls?.destroy(),
      () => this.input.clear(),
      () => this.runtime?.destroy(),
      () => this.simulation?.destroy(),
      () => this.tools?.destroy(),
      () => this.renderer?.destroy(),
      () => this.physics?.destroy(),
      () => this.assets?.destroy(),
    ]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    this.controls = undefined;
    this.runtime = undefined;
    this.simulation = undefined;
    this.tools = undefined;
    this.renderer = undefined;
    this.physics = undefined;
    this.assets = undefined;
    this.world = undefined;
    this.presentation = undefined;
    this.operations.clear();
    if (failures.length) throw new AggregateError(failures, 'Game session cleanup failed.');
  }
}
