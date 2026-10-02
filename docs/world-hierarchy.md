# Scalable gameplay hierarchy

Phase 2 moves Entity and World implementations into `src/engine/world/`. Existing imports from `src/engine/world.ts`, `src/engine/entity.ts`, and the public barrels still work. The gameplay hierarchy remains separate from every model's glTF hierarchy. Animation owns model locals; gameplay or physics owns entity roots through the existing supported setters.

## Evaluation and revisions

`EntityHierarchy` stores parents, child adjacency and roots. It builds a cached preorder with parent references and an exclusive end index for each subtree. An explicit stack builds this order; validation, scene loading and subtree destruction also avoid recursive entity traversal. Topology edits invalidate the cache, releasing old entity references immediately. The next dirty evaluation rebuilds it once, even after several edits.

An entity tracks its local revision, the last evaluated parent identity/revision and its effective world revision. `setTransform()` validates and normalizes a copied candidate, checks writer authority, and marks that entity dirty only when the normalized TRS changes. Parent-only motion reuses its local matrix. Candidate world matrices must be finite before replacing the previous matrix. Exact float32 comparisons advance the effective revision only when the resulting matrix changes; equivalent quaternion signs and equal placements after reparenting can stop propagation.

`World.updateTransforms()` sorts explicitly dirty entities in cached parent-first order. A changed effective matrix walks its subtree; an unchanged matrix skips that subtree's cached range. Independently dirty descendants remain scheduled even when their parent is unchanged. Evaluation markers ensure overlapping dirty branches run at most once. A held hierarchy performs no entity visits or matrix recomputations. Transform getters still return copies, and removed entity references cannot dirty a new entity with the same ID.

Model roots synchronize only after an effective entity-world change. Existing pose revisions then update skin palettes, mesh/light worlds, bounds, winding, shadow dependencies and visibility during rendering preparation. Independent model animation and node overrides remain observable on held entity roots. World scans its cached model-instance set for pose revision changes; animation work is separate from gameplay hierarchy work. This phase does not optimize the internal glTF hierarchy or remove renderer-side model revision checks.

Call `world.update(timestampMs)` after gameplay/physics writes to evaluate animation and entity roots, or let EngineRuntime do this. `updateTransforms()` evaluates roots without advancing animation. Rendering consumes evaluated state and keeps pose upload → compute deformation → shadows → color → presentation separate. Skipping rendering does not consume revisions. Stale visibility cannot suppress deformation or shadow work.

Numeric evaluation failures preserve each entity's last finite matrix and mark all live entities for retry, including descendants of an already updated parent. Fix the invalid local transforms and evaluate again before rendering. This is recovery from an evaluation failure, not an atomic rollback of all transforms in that evaluation.

## Structural boundary

Existing synchronous `createEntity()`, `setParent()` and `destroyEntity()` APIs remain available. Single reparenting validates ancestors before mutation; it preserves local TRS. Destroy removes the entire current gameplay subtree using child adjacency.

Use `applyChanges()` for an explicit atomic topology boundary:

```ts
import { World, type WorldChange } from './src';

const world = new World();
const changes: WorldChange[] = [
  { type: 'create', entity: { id: 'child', parent: 'group' } },
  { type: 'create', entity: { id: 'group', transform: { translation: [4, 0, 0] } } },
];
const created = world.applyChanges(changes); // Parents may be created later in the batch.
world.updateTransforms();

world.applyChanges([
  { type: 'create', entity: { id: 'destination' } },
  { type: 'reparent', id: 'child', parent: 'destination' },
  { type: 'destroy', id: 'group' },
]);
world.updateTransforms();
```

Commands execute in order on a candidate graph. A destroy uses that candidate's current child links; reparent before destruction to retain a child. Final parent presence and cycles are checked before publication. Invalid definitions, missing models, duplicate IDs, missing parents and cycles leave the live graph, revisions and existing entity identities unchanged. Successful batches return surviving newly created entities; a batch with no net topology change returns an empty array. Removed entities lose their world dirty callback.

Batch staging copies the graph and validates it with a linear iterative parent-chain walk. It permits forward parent references and avoids repeating ancestor walks while loading an unordered scene. It uses O(N) temporary graph storage; this is a CPU topology transaction, not incremental GPU instance allocation.

`hierarchyRevision` advances once per actual committed batch (or successful single topology edit). `structureRevision` advances only when entity membership changes. Reparenting changes topology without rebuilding GPU membership. After creating/destroying entities, evaluate roots and await `renderer.setWorld(world)` before submitting new membership. Pure transform/reparent changes need evaluation and rendering only. Same-world `setWorld()` or `syncWorld()` now retain surviving render instances; see [Phase 3 membership](rendering-membership.md).

## Diagnostics and measurements

`world.hierarchyStats` returns a copied snapshot of the last transform evaluation:

| Counter           | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| visitedEntities   | Entries actually inspected, excluding skipped subtree ranges |
| recomputedWorlds  | Candidate world matrices calculated                          |
| changedWorlds     | Effective world matrices whose revisions advanced            |
| syncedModelRoots  | Model roots synchronized after entity-world changes          |
| traversalRebuilds | Cache rebuilds during this evaluation                        |

`Entity.localRevision`, `worldRevision` and `parentWorldRevision` expose read-only revision numbers. With `world.profiling = true`, `cpuTimings.hierarchyMs` measures hierarchy evaluation and model revision aggregation within `evaluationMs`. Existing mixing/world timings describe model pose work; do not add overlapping timings together.

Run `pnpm bench:hierarchy` for 1,000 / 10,000 / 25,000-entity wide and deep trees, including child-before-parent input. Each mode warms up for 10 evaluations and measures 30: held, one changing leaf, and a changing root affecting every entity. The comparison is a test-only reproduction of the previous recursive full traversal with local reconstruction and copied parent matrices. Construction and initialization are recorded separately.

The [Phase 2 baseline](baselines/hierarchy-phase2-2026-10-02.json) records browser/platform and raw results. On this Windows Edge run, the 25,000-entity wide tree recomputed 0 matrices when held, 1 for a leaf edit and 25,000 for root motion, versus 25,000 in every historical mode. Fully moving wide-tree p95 was 2.5 ms versus 12.1 ms. Deep 25,000-entity root motion measured 2.0 ms p95; the historical traversal overflowed at 10,000 and 25,000 deep entities.

These are CPU-only, gameplay-only measurements, with no GPU, animation or model instances. Zero-millisecond samples reflect browser timer resolution, not a claim of zero execution time. Counts are deterministic acceptance checks; timings depend on browser, machine, warmup and workload. The [Phase 2 migration baseline](baselines/migration-phase2-2026-10-02.json) also measures complete 16 / 128 / 512-entity scenes, separates hierarchy/evaluation from rendering, and records zero tracked live GPU bytes after destruction in all three workloads. These requested resource bytes are estimates, not physical VRAM measurements.

CPU regressions cover 25,000-deep evaluation/loading/destruction, dirty branch isolation, overlapping roots, unchanged effective transforms, copied getters, writer handoff, atomic failure and numeric retry. The real GPU world regression checks held pose uploads, selective parent changes, reparenting without resource rebuild, deformation against the CPU oracle, lights, winding, bounds/visibility and pass order.
