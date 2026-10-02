import type { World } from '../world';
import type { SimulationStep, EngineFrame } from '../runtime/types';
import { identifier } from '../serialization/json';

export interface SystemContext {
  readonly world: World;
}
export interface EngineSystem {
  readonly id: string;
  readonly phase: 'gameplay' | 'physics' | 'presentation';
  /** Ascending order within a phase; equal orders keep registration order. */
  readonly order?: number;
  initialize?(context: SystemContext): void;
  fixedUpdate?(context: SystemContext, step: SimulationStep): void;
  presentationUpdate?(context: SystemContext, frame: EngineFrame): void;
  destroy?(context: SystemContext): void;
}

/** A fixed CPU schedule, not an ECS. Capture callbacks/order at construction so
 * class-based systems retain their receiver and outside edits cannot reorder a frame. */
export class SystemScheduler {
  private context: SystemContext;
  private records;
  private initialized: { id: string; destroy?: (context: SystemContext) => void }[] = [];
  private started = false;
  private disposed = false;
  constructor(world: World, systems: readonly EngineSystem[]) {
    this.context = Object.freeze({ world });
    const ids = new Set<string>();
    const phases = { gameplay: 0, physics: 1, presentation: 2 };
    this.records = systems
      .map((system, index) => {
        identifier(system.id);
        if (ids.has(system.id)) throw new Error(`Duplicate system ${system.id}.`);
        ids.add(system.id);
        if (!Object.hasOwn(phases, system.phase) || !Number.isFinite(system.order ?? 0))
          throw new Error(`Invalid system schedule ${system.id}.`);
        if (
          system.phase === 'presentation'
            ? !!system.fixedUpdate || !system.presentationUpdate
            : !!system.presentationUpdate || !system.fixedUpdate
        )
          throw new Error(
            `System ${system.id} requires the callback for its ${system.phase} phase only.`,
          );
        return {
          id: system.id,
          phase: system.phase,
          order: system.order ?? 0,
          index,
          initialize: system.initialize?.bind(system),
          destroy: system.destroy?.bind(system),
          fixedUpdate: system.fixedUpdate?.bind(system),
          presentationUpdate: system.presentationUpdate?.bind(system),
        };
      })
      .sort((a, b) => phases[a.phase] - phases[b.phase] || a.order - b.order || a.index - b.index);
  }
  initialize(): void {
    if (this.disposed) throw new Error('Engine systems are disposed.');
    if (this.started) return;
    this.started = true;
    try {
      for (const record of this.records) {
        // Include the failing initializer: it can own partially initialized resources.
        this.initialized.push(record);
        this.invoke(record.id, 'initialize', () => record.initialize?.(this.context));
        if (this.disposed) throw new Error('Engine systems disposed during initialization.');
      }
    } catch (error) {
      try {
        this.destroy();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'System initialization and cleanup failed.');
      }
      throw error;
    }
  }
  private invoke(id: string, phase: string, run: () => unknown): void {
    try {
      const result = run();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => {});
        throw new Error('System callbacks must be synchronous.');
      }
    } catch (cause) {
      throw new Error(`System ${id} ${phase} failed.`, { cause });
    }
  }
  fixedUpdate(phase: 'gameplay' | 'physics', step: SimulationStep): void {
    if (this.disposed) throw new Error('Engine systems are disposed.');
    for (const record of this.records)
      if (record.phase === phase)
        this.invoke(record.id, phase, () => record.fixedUpdate!(this.context, step));
  }
  presentationUpdate(frame: EngineFrame): void {
    if (this.disposed) throw new Error('Engine systems are disposed.');
    for (const record of this.records)
      if (record.phase === 'presentation')
        this.invoke(record.id, 'presentation', () =>
          record.presentationUpdate!(this.context, frame),
        );
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const record of this.initialized.splice(0).reverse()) {
      try {
        this.invoke(record.id, 'destroy', () => record.destroy?.(this.context));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Engine system cleanup failed.');
  }
}
