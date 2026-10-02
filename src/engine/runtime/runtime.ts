import type { World } from '../world';

import type { SimulationStep, EngineFrame } from './types';
export type { SimulationStep, EngineFrame } from './types';
import { SystemScheduler, type EngineSystem } from '../systems/scheduler';

export interface RuntimeHooks {
  captureInput?(wallTimestampMs: number): void;
  gameplay?(step: SimulationStep): void;
  physics?(step: SimulationStep): void;
  /** Optional interpolation/overrides before visual animation and root evaluation. */
  preparePresentation?(frame: EngineFrame): void;
  /** Application-owned camera preparation/render call; omit to simulate headlessly. */
  present?(frame: EngineFrame): void;
}
export interface RuntimeOptions {
  systems?: readonly EngineSystem[];
  stepMs?: number;
  maxSteps?: number;
  maxFrameMs?: number;
}
export interface RuntimeCheckpoint {
  version: 1;
  stepMs: number;
  simulationTimeMs: number;
  accumulatorMs: number;
  paused: boolean;
}
export function validateRuntimeCheckpoint(state: RuntimeCheckpoint): void {
  if (
    !state ||
    state.version !== 1 ||
    !Number.isFinite(state.stepMs) ||
    state.stepMs <= 0 ||
    typeof state.paused !== 'boolean' ||
    !Number.isFinite(state.simulationTimeMs) ||
    state.simulationTimeMs < 0 ||
    !Number.isFinite(state.accumulatorMs) ||
    state.accumulatorMs < 0 ||
    state.accumulatorMs >= state.stepMs
  )
    throw new Error('Invalid runtime checkpoint.');
}

/** CPU coordination only: no RAF, canvas or GPU. Presentation time advances by
 * accepted simulation time, so suspension cannot fast-forward clips or physics. */
export class EngineRuntime {
  private lastTimestamp?: number;
  private accumulator = 0;
  private simulationTime = 0;
  private paused = false;
  private disposed = false;
  private advancing = false;
  private systems: SystemScheduler;
  readonly stepMs: number;
  readonly maxSteps: number;
  readonly maxFrameMs: number;
  checkpoint(): RuntimeCheckpoint {
    if (this.advancing || this.disposed)
      throw new Error('Capture runtime at an idle frame boundary.');
    return {
      version: 1,
      stepMs: this.stepMs,
      simulationTimeMs: this.simulationTime,
      accumulatorMs: this.accumulator,
      paused: this.paused,
    };
  }
  restore(state: RuntimeCheckpoint): void {
    validateRuntimeCheckpoint(state);
    if (this.advancing || this.disposed || state.stepMs !== this.stepMs)
      throw new Error('Invalid runtime checkpoint or fixed step.');
    this.simulationTime = state.simulationTimeMs;
    this.accumulator = state.accumulatorMs;
    this.paused = state.paused;
    this.lastTimestamp = undefined;
  }
  constructor(
    readonly world: World,
    private hooks: RuntimeHooks = {},
    options: RuntimeOptions = {},
  ) {
    this.stepMs = options.stepMs ?? 1000 / 60;
    this.maxSteps = options.maxSteps ?? 5;
    this.maxFrameMs = options.maxFrameMs ?? 250;
    if (
      ![this.stepMs, this.maxFrameMs].every((value) => Number.isFinite(value) && value > 0) ||
      !Number.isSafeInteger(this.maxSteps) ||
      this.maxSteps < 1
    )
      throw new Error('Invalid fixed-step runtime options.');
    this.systems = new SystemScheduler(world, options.systems ?? []);
  }
  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.lastTimestamp = undefined;
    }
  }
  resume(): void {
    if (this.paused) {
      this.paused = false;
      this.lastTimestamp = undefined;
    }
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.systems.destroy();
  }
  advance(timestampMs: number): EngineFrame {
    if (this.disposed) throw new Error('Engine runtime is disposed.');
    if (
      !Number.isFinite(timestampMs) ||
      (this.lastTimestamp !== undefined && timestampMs < this.lastTimestamp)
    )
      throw new Error('Engine timestamps must be finite and monotonic.');
    if (this.advancing) throw new Error('Engine advance cannot be reentrant.');
    this.advancing = true;
    try {
      this.systems.initialize();
      return this.advanceFrame(timestampMs);
    } finally {
      this.advancing = false;
    }
  }
  private advanceFrame(timestampMs: number): EngineFrame {
    this.hooks.captureInput?.(timestampMs);
    const elapsed =
      this.paused || this.lastTimestamp === undefined ? 0 : timestampMs - this.lastTimestamp;
    this.lastTimestamp = this.paused ? undefined : timestampMs;
    let droppedMs = Math.max(0, elapsed - this.maxFrameMs);
    this.accumulator += Math.min(elapsed, this.maxFrameMs);
    let steps = 0;
    while (!this.paused && this.accumulator >= this.stepMs * (1 - 1e-9) && steps < this.maxSteps) {
      this.simulationTime += this.stepMs;
      this.accumulator = Math.max(0, this.accumulator - this.stepMs);
      const step = Object.freeze({
        deltaSeconds: this.stepMs / 1000,
        simulationTimeMs: this.simulationTime,
      });
      this.systems.fixedUpdate('gameplay', step);
      this.hooks.gameplay?.(step);
      this.systems.fixedUpdate('physics', step);
      this.hooks.physics?.(step);
      steps++;
    }
    // Drop whole excess steps; retain the fractional remainder for interpolation.
    if (this.accumulator >= this.stepMs) {
      const excess = Math.floor(this.accumulator / this.stepMs) * this.stepMs;
      droppedMs += excess;
      this.accumulator -= excess;
    }
    const frame = Object.freeze({
      simulationTimeMs: this.simulationTime,
      presentationTimeMs: this.simulationTime + this.accumulator,
      alpha: this.accumulator / this.stepMs,
      steps,
      droppedMs,
      paused: this.paused,
    });
    this.systems.presentationUpdate(frame);
    this.hooks.preparePresentation?.(frame);
    this.world.update(frame.presentationTimeMs);
    this.hooks.present?.(frame);
    return frame;
  }
}
