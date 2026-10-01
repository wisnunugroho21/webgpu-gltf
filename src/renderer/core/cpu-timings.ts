/** Opt-in CPU wall times in milliseconds. Encoding measures command construction,
 * never GPU execution or presentation latency. Nested pose times belong to animationMs. */
export interface CpuTimings {
  animationMs: number;
  mixingMs: number;
  worldMs: number;
  uploadsMs: number;
  visibilityMs: number;
  encodingMs: number;
  submissionMs: number;
  totalMs: number;
  sampledNodes: number;
  visitedNodes: number;
}

export function emptyCpuTimings(): CpuTimings {
  return {
    animationMs: 0,
    mixingMs: 0,
    worldMs: 0,
    uploadsMs: 0,
    visibilityMs: 0,
    encodingMs: 0,
    submissionMs: 0,
    totalMs: 0,
    sampledNodes: 0,
    visitedNodes: 0,
  };
}
