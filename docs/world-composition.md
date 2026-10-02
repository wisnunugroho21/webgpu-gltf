# Cached world draw composition

Refactoring part 5 separates CPU draw composition into `renderer/scene/world-composition.ts`. `world-builder.ts` still owns snapshot validation, membership differences, resource acquisition, transform slots/staging, binding capacity and deferred commit uploads. `WorldDrawComposition` consumes ordered prepared model data and owns no GPU resources or leases. Its small contract in scene types avoids a circular dependency between scene data and the cache implementation.

## Why extract it

Run `npm run bench:composition`. The benchmark prepares real WebGPU model records, then measures repeated removal candidates against the attached scene without publishing them. Each model contains eight opaque primitives sharing geometry/material resources. Five warmups precede 25 samples at 128, 512 and 2,048 models. Existing acquisition is only lease retention; no buffers or requested buffer bytes are allocated in the timed workload, enforced by assertions. CPU world construction, rendering, GPU execution and validation-scope completion are excluded.

The original composition dominated warm preparation at 2,048 models: 2.8 ms median out of 3.6 ms total. That justified separating and caching the structural work. Recorded local results on Edge 154 / Intel gen-12lp are:

| Models before removal | Original composition median | Cached composition median | Original total median | Cached total median |
| --------------------- | --------------------------- | ------------------------- | --------------------- | ------------------- |
| 128                   | 0.2 ms                      | 0.2 ms                    | 0.3 ms                | 0.2 ms              |
| 512                   | 0.7 ms                      | 0.4 ms                    | 1.0 ms                | 0.6 ms              |
| 2,048                 | 2.8 ms                      | 1.9 ms                    | 3.6 ms                | 2.7 ms              |

The [before](baselines/world-composition-before-2026-10-02.json) and [after](baselines/world-composition-after-2026-10-02.json) reports include all phase distributions, browser/device metadata and measurement scope. These are separate local runs, not universal performance guarantees. Timer granularity is approximately 0.1 ms and GC contributes to outliers; the large workload's composition p95 increased from 3.9 to 4.8 ms despite its lower median. Latency is descriptive, never a CI pass/fail threshold. The fixture deliberately stresses a single shared material bucket: an affected bucket must still copy its surviving references. It does not characterize a particular game's spawn frequency, mixed-material workload, animation or GPU frame performance.

`prepareWorld()` has an optional internal profiling callback. Without it no timer reads occur. Composition includes light selection, structural lists, live bounds/statistics and retained pose-revision remapping. Subphases distinguish the cached index, current bounds/statistics and revision remapping. They are nested measurements; do not add them again when summing top-level preparation phases. The callback is not part of the public renderer API, and inserts no GPU waits.

## Cache contract

Prepared model array identities describe membership. Flat draw/update/forward lists compare ordered nonempty source arrays; unchanged lists retain identity. Opaque buckets compare ordered sources independently per pipeline/material; a change copies only that bucket's draw list. New maps wrap reused lists so staging cannot mutate the active maps. Removed/replaced models leave the next cache, and reordering changes draw order where necessary. An entity-only structural change with identical model membership can retain the entire cache.

Prepared pipeline summaries are reused per surviving model. Both opaque winding alternatives and outline alternatives remain represented, rather than caching the currently selected pipeline. Forward pipeline selections are read from live transparent/transmission draws when composing candidate statistics. Draw objects, pose updates, light instances and private deformation outputs retain their identity.

The source/bucket lists are structural data: render consumers iterate them, and must not sort, splice or append them. Bounds, winding, centers and visibility runs within each draw remain mutable. Every candidate rereads current draw bounds; cached model min/max values are unsuitable after gameplay movement or deformation. Visible forward lists, pending deformation lists, bounds aggregates and transform staging remain candidate-owned. Frame sorting operates only on the visible scratch lists.

Light source selection uses authored lights when present and otherwise one fallback. Unchanged source identity retains the combined light object, whose instances remain live and whose update method visits the selected model sources. Addition/removal reevaluates selection and the existing 32-light limit. Geometry-free and empty worlds keep finite neutral bounds and valid fallback lighting.

## Ownership and limits

The attached scene retains the composition cache. A candidate shares structural lists with its predecessor but never retains a reference to the previous cache itself. Failed candidates are discarded without modifying active structure or resource leases. A different world/device starts a fresh cache. Existing resource acquisition and commit-only slot writes are unchanged; survivors retain handles, pose revisions and output buffers. Occlusion invalidation and upload → compute → shadows → color → presentation ordering remain unchanged.

Membership snapshots, slot cloning, lease retention, transform staging and live bounds scans still scale with world size. Affected flat lists/shared buckets still require copies. This extraction adds reference metadata and pipeline summaries; it does not add GPU buffers, merge deformation arenas or introduce persistent GPU visibility indexes. Further complexity needs measurements on an actual game workload.

CPU regressions cover affected/untouched bucket identity, candidate isolation, empty models/worlds, replacement/reordering, forward lists, live bounds, winding/outline alternatives, light selection and limits. Existing real GPU membership/world/recovery tests verify retained outputs, atomic uploads, disposal, authored lights and phase order.
