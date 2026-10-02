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
