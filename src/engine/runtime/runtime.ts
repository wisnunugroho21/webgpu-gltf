import type { World } from '../world';

export interface SimulationStep {
  readonly deltaSeconds: number;
  readonly simulationTimeMs: number;
}
export interface EngineFrame {
  readonly simulationTimeMs: number;
  readonly presentationTimeMs: number;
  readonly alpha: number;
  readonly steps: number;
  readonly droppedMs: number;
  readonly paused: boolean;
}
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
  stepMs?: number;
  maxSteps?: number;
  maxFrameMs?: number;
}

/** CPU coordination only: no RAF, canvas or GPU. Presentation time advances by
 * accepted simulation time, so suspension cannot fast-forward clips or physics. */
export class EngineRuntime {
  private lastTimestamp?: number;
  private accumulator = 0;
  private simulationTime = 0;
  private paused = false;
  private disposed = false;
  readonly stepMs: number;
  readonly maxSteps: number;
  readonly maxFrameMs: number;
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
    this.disposed = true;
  }
  advance(timestampMs: number): EngineFrame {
    if (this.disposed) throw new Error('Engine runtime is disposed.');
    if (
      !Number.isFinite(timestampMs) ||
      (this.lastTimestamp !== undefined && timestampMs < this.lastTimestamp)
    )
      throw new Error('Engine timestamps must be finite and monotonic.');
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
      this.hooks.gameplay?.(step);
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
    this.hooks.preparePresentation?.(frame);
    this.world.update(frame.presentationTimeMs);
    this.hooks.present?.(frame);
    return frame;
  }
}
