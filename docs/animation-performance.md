# Animated-scene CPU work

Measured locally on October 2, 2026 using headless Edge and the Intel Gen-12LP adapter. The existing `npm run bench:occlusion` harness now records `Renderer.cpuTimings`, prepared scene draws and pose-update draw counts. The scene, warmup, sample count, query instrumentation and synchronization follow the [occlusion benchmark method](occlusion-benchmark.md).

The baseline used the previous builder, pose and mixer with CPU timer instrumentation added; the renderer, visibility and query code were unchanged. The optimized capture used static instance grouping plus sparse mixing/world evaluation. Both enabled CPU profiling, used 320×240 single-sample rendering with shadows disabled, eight warmup frames and 16 measured frames. Raw captures: [baseline](benchmarks/animation-cpu-before.json) and [optimized](benchmarks/animation-cpu-after.json). The harness writes new results to `test-results/occlusion-benchmark.json`.

## Results

Medians for 8,192 cubes with occlusion enabled. Prepared draws count all scene draw records, including currently hidden geometry. Visited nodes include the wall, cubes and auxiliary node in the baseline.

| Scenario                    | CPU frame ms before → after | Mixing ms before → after | World ms before → after | Prepared draws before → after | Visited nodes before → after |
| --------------------------- | --------------------------- | ------------------------ | ----------------------- | ----------------------------- | ---------------------------- |
| Unrelated animation         | 6.7 → 0.5                   | 4.2 → <0.1               | 1.2 → <0.1              | 8193 → 2                      | 8194 → 1                     |
| Moving transparent receiver | 7.1 → 0.7                   | 4.2 → <0.1               | 1.2 → <0.1              | 8194 → 3                      | 8194 → 1                     |
| Moving opaque wall          | 7.6 → 0.6                   | 4.3 → <0.1               | 1.2 → <0.1              | 8193 → 2                      | 8194 → 1                     |
| Static scene                | 0.5 → 0.6                   | 0 → 0                    | 0 → 0                   | 2 → 2                         | 0 → 0                        |

With occlusion disabled, unrelated animation submits all 8,193 instances and improves from 7.1 ms to 0.3 ms of CPU frame time. Visibility remains linear in instance count; grouping reduces draw construction and pose-update scans while sparse mixing removes resets/blends of unaffected local arrays. In the optimized unrelated-animation case with occlusion enabled, visibility accounts for about 0.4 ms of the 0.5 ms CPU frame median.

The measured zeroes in short phases mean those medians were below the browser's approximately 0.1 ms timer granularity. They do not imply free execution. Independent phase medians need not sum to the frame median. These small synthetic meshes measure CPU scaling; synchronized completion includes harness waits and is not a production FPS measurement. Background viewer work and driver load add noise. This is one adapter, with no speedup promised for fully animated hierarchies or full-pose snapshots.

## Implementation and invariants

- Classify every authored TRS target and its descendants at load time, across all clips. Only unaffected rigid instances share static groups. Skins and morphs keep independent output ownership, even if their current pose is held.
- Mix only active local targets plus outgoing targets that must restore authored defaults. Cache selections while positive-weight layer membership stays constant; discard outgoing targets after restoration. Whole-pose blend semantics retain each other layer's default contribution for missing channels.
- Evaluate affected world subtrees in parent order; weight-only changes need no descendant traversal. Compare final float32 matrices and weights before advancing revisions. Clear only previously changed world flags.
- Snapshot-based interrupted fades conservatively mix/evaluate all nodes. Leaving the snapshot restores outgoing values before shrinking selections. Prepared clip targets and hierarchy membership are immutable.
- Preserve pose uploads → compute → shadows → color. Visibility cannot skip deformation or shadow updates. Static groups retain instance addressing, mirrored winding and per-instance bounds; transparent ordering remains independent.

`tests/sparse-pose.test.ts` compares sparse local mixing against a full-scene mixer through clip switches, blends, zero-weight layers and snapshots in a 2,052-node scene. It also checks parent propagation, outgoing-target retirement and restoration after invalid requests. `browser-tests/animated-instancing.spec.ts` compares actual rendered pixels with a deliberately independent-draw reference through parent motion, authored restoration and culling changes. Existing skin/morph, blending, occlusion and shadow regressions cover downstream phase ordering and dirty tracking.
