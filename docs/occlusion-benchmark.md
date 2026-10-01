# Occlusion cost and moving-scene effectiveness

The baseline was measured before changing the visibility code. Its queries were asynchronous, but every changed pose invalidated the entire result set. Unrelated animation or a moving transparent receiver therefore repeatedly paid for queries without retaining any occlusion savings. Static scenes also reissued every query indefinitely.

## Method and raw results

Run `npm run bench:occlusion`. The harness writes `test-results/occlusion-benchmark.json`. Checked-in captures are [before](benchmarks/occlusion-before.json) and [after](benchmarks/occlusion-after.json).

The test uses headless Microsoft Edge on the local Intel Gen-12LP adapter, 320×240 physical render pixels, single-sample rendering, and disabled shadows. It measures 128, 2,048 and 8,192 cubes behind an opaque wall, with static, unrelated animation, moving transparent receiver, moving occluder and moving camera variants. Every variant compares culling off/on, warms up eight frames, then records 16 samples. Animated fixtures create independent draws using the existing scene builder, so their CPU costs also include pose traversal and draw preparation.

GPU query-pass time uses optional timestamp writes at pass boundaries, excluding resolve/copy/readback. CPU time measures the synchronous renderer frame call, including uploads, visibility, encoding and submission. Completion time additionally waits for GPU work and query delivery **in the harness only**. It is a synchronization/latency comparison, not an FPS or production throughput estimate. Browser CPU timer granularity is roughly 0.1 ms; device load, driver scheduling and background viewer work can affect results. The baseline capture did not serialize adapter-info fields; the later capture explicitly records vendor/architecture. Both ran on the same local setup.

## Measured 8,192-object results

Medians with occlusion enabled; counts describe color-scene submissions including the wall and any transparent receiver:

| Scene                       | Queries before → after | Query GPU ms before → after | CPU frame ms before → after | Synchronized completion ms before → after | Instances drawn before → after |
| --------------------------- | ---------------------- | --------------------------- | --------------------------- | ----------------------------------------- | ------------------------------ |
| Static                      | 4096 → 0               | 2.046 → 0                   | 1.5 → 0.5                   | 10.9 → 3.1                                | 1 → 1                          |
| Unrelated node animation    | 4096 → 0               | 2.016 → 0                   | 8.2 → 6.6                   | 20.5 → 7.6                                | 8193 → 1                       |
| Moving transparent receiver | 4096 → 1               | 2.028 → 0.003               | 8.8 → 7.2                   | 20.8 → 10.0                               | 8194 → 2                       |
| Moving opaque occluder      | 4096 → 0               | 2.037 → 0                   | 8.5 → 7.6                   | 20.1 → 13.0                               | 8193 → 8193                    |
| Moving camera               | 4096 → 0               | 2.008 → 0                   | 1.4 → 0.5                   | 10.3 → 3.1                                | 8193 → 8193                    |

Zero query time means the pass was omitted after warmup; it does not mean query execution itself became free. The initial unknown set still needs bounded query batches. Smaller static/unrelated scenes also settle to zero queries. The moving-occluder/camera cases retain no hidden history and draw conservatively; their improvement is avoiding futile query work, not culling during motion.

## Implemented policy

1. Scene, camera, viewport and filter changes invalidate the global depth epoch.
2. Geometry dependency revisions include rigid world transforms, morph weights and active influencing joints. World-space skinning ignores mesh-node-only movement. Unrelated/light nodes and inactive joints do not invalidate depth.
3. Changed opaque/MASK geometry invalidates all results. Changed BLEND/transmission geometry invalidates only its receiver ID. MASK coverage remains an occluder dependency.
4. Readback snapshots carry the epoch and receiver revisions. Delivery discards obsolete answers rather than hiding moved geometry.
5. Accepted visible/hidden results remain valid until those dependencies change. Stable instances need no more queries, and cached hidden instances avoid repeated bound projections.
6. Two consecutive camera/occluder changes suspend new queries, with unknown geometry drawn. The next stable frame immediately queries unknown candidates again.

`renderer.occlusionStats` reports submitted queries for the latest frame, known/hidden instance counts, allocated capacity, pending delivery, consecutive unstable frames and discarded results. Its snapshot does not enable timestamp instrumentation in production.

Visibility still runs **after pose uploads and bounds updates** and before command encoding. Compute deformation and shadow preparation/encoding never depend on cached color visibility. Browser regressions compare pixels with culling disabled, delay a transparent receiver's query while moving it, preserve unrelated opaque history, verify motion suspension/recovery, and prove hidden/scale-culled deforming meshes still compute and regenerate shadows. CPU tests cover active-joint/morph dependencies and opaque/MASK versus transparent invalidation.

## Depth pyramid, BVH and GPU visibility investigation

The baseline's roughly 2 ms query batches justified eliminating repeated work first. Following that change, steady static/unrelated animation issues no queries, while moving transparent geometry needs one. A new hierarchy would add work without reducing those measured steady query counts. GPU-driven draws would also require compatible state grouping and indirect argument management; they cannot remove CPU animation/hierarchy evaluation by themselves.

| Option                                 | Benefit to measure next                                                         | Requirements and correctness constraints                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU BVH with grouped queries           | Faster initial visibility discovery or CPU traversal in spatially sparse scenes | Refit animated bounds before testing; retain stable original instance IDs and fail open for unknown groups. Measure refit/traversal overhead and visible-group worst cases.                                         |
| Hierarchical depth pyramid             | Culling during changing views using current-frame depth                         | Build conservative maximum-depth levels, handle MSAA/background holes and near-plane boxes, and keep glass out of occluder depth. Requires an opaque depth preparation strategy and additional GPU passes.          |
| GPU visibility and indirect submission | Less CPU draw submission for genuinely complex/many-draw scenes                 | Group compatible pipelines/materials, compact visibility/indirect records on GPU, preserve `firstInstance` addressing and transparent ordering. Changed deformation and all shadow casters must still update first. |

Spatial hierarchies can reduce query counts by testing groups, but their benefits depend on visible scene structure and query overhead; see NVIDIA's [Hardware Occlusion Queries Made Useful](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-6-hardware-occlusion-queries-made-useful). This project retains exact dependency checks rather than predicting hidden status across motion.

The measurements support shipping dependency reuse and motion suspension now. A pyramid/BVH/indirect path is **not implemented here**: these simple cubes do not establish that its added passes/refits would pay off. The next justified experiment is a high-triangle indoor scene and a spatially sparse scene under continuous camera motion, measuring whole-frame GPU time, CPU visibility/draw time and pixel correctness on at least a second adapter. Current behavior deliberately forgoes occlusion savings during continuously changing opaque depth; it remains safe and removes the previous query penalty.
