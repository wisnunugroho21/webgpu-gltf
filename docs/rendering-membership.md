# Retained rendering membership

Phase 3 keeps rendering records alive across spawn/destruction in the same World. The engine captures and diffs model membership in `engine/rendering/world-snapshot.ts`; device-side composition prepares only additions and retains surviving records. glTF node indices stay local to each model. The viewer and `setAsset()` retain their existing lifecycle.

## Explicit synchronization

```ts
// Pause render submissions while applying membership changes.
world.applyChanges([
  { type: 'create', entity: { id: 'npc', model: { asset: 'hero' } } },
  { type: 'destroy', id: 'obsolete' },
]);
world.update(presentationTimeMs); // Animation, overrides and entity roots are CPU work.
await renderer.syncWorld(world);
renderer.render(presentationTimeMs, camera.view(renderer.aspectRatio));
```

`setWorld(world)` remains supported: its same-world calls use this incremental path too. A different World starts a new attachment. `syncWorld()` neither advances animation nor schedules frames. Membership edits are collected in the CPU world until this explicit boundary; requests serialize on the device preparation queue alongside asset/environment preparation. The snapshot is taken when a queued request starts. Edits during asynchronous preparation invalidate its revision and reject that candidate; synchronize again after the edits finish. Unchanged synchronization returns the attached scene without allocations, camera reframing or occlusion invalidation.

An entity with a reused ID owns a new ModelInstance, so it receives new private pose/output resources. Surviving ModelInstance identities retain their draw records, model-resource leases, GPU deformation outputs and last-uploaded pose revisions. Transform, parent, playback and explicit node-override changes use evaluation/rendering without membership synchronization. Same-world synchronization preserves the camera; initial attachment still applies automatic viewer framing.

## Handles, slots and binding capacity

`renderer.getRenderInstanceHandle(model)` returns an immutable handle for the currently attached model, or undefined after removal commits. `RenderInstanceHandle` is exported publicly. Its `id` identifies a model's render allocation independently of gameplay IDs and glTF node indices; `firstInstance` and `count` describe its contiguous range of transform records. Individual draws keep their offsets within that range. A survivor returns the same handle object and addresses through membership commits.

`InstanceSlots` clones allocation metadata for staging. Removed ranges become free in the candidate; adjacent holes coalesce and additions use a fitting hole before extending the address space. Reusing a range creates a new handle identity. Handles belong to one attachment; do not carry them between different-world attachments or renderer devices. Consumers should resolve the current model handle rather than infer identity from a numeric slot.

The global storage buffer/bind group survive when capacity suffices. Growth allocates a larger buffer, copies the current CPU transform records at their existing addresses, and changes the binding only at commit. Capacity doubles up to device binding limits to amortize later growth. Partial removal retains capacity and leaves holes; it does not compact surviving addresses. An empty world releases the larger binding and keeps a single neutral 128-byte transform record. Growth can reserve more steady-state memory than tightly packed full preparation; it trades headroom for fewer allocations. This is bounded by device limits, with budget-aware shrinking/compaction left for measured future work.

CPU composition now reuses unaffected structural draw lists/buckets and prepared pipeline summaries through `WorldDrawComposition`, separately from acquisition. Changed lists still copy references, bounds remain live scans, and slot metadata/transform staging still copy at membership boundaries. Its cost still scales with surviving membership/capacity; see [composition profiles and cache contracts](world-composition.md). Retention removes surviving private GPU allocation/preparation and address churn, not all O(N) CPU work. Deformation batching remains within each prepared model's compatible primitives; this phase does not merge private output arenas across models.

## Transactional lifetime and visibility

Each model's private resources and the transform binding have separately retained lifetimes. A candidate takes leases on survivors; new private resources remain candidate-owned. CPU checks, GPU validation scopes and the final world revision check complete before scene publication. Failed candidates release their leases and new allocations without releasing active resources or changing active slots/draws. Shared geometry, textures, materials and immutable deformation inputs remain leased until their last model consumer ends.

A reused binding must not be written during staging: its candidate slots can overlap an entity still present in the attached scene. New range uploads run only during the synchronous validated commit. Growth uploads to a separate candidate buffer. After publication, old scene leases release removed private resources and replaced bindings. WebGPU submission ordering keeps earlier submitted work ordered before commit writes; no per-membership GPU completion wait is introduced.

Every actual membership commit invalidates the occlusion generation, clears visibility history and creates a new scene identity. Delayed query readbacks carry the previous generation and are discarded before they can hide a new occupant of a reused slot. Visibility therefore fails open until fresh queries finish. Model revisions still drive uploads and deformation independently of visibility. Upload → compute → shadows → color → presentation remains the rendering order. New outputs compute once; held survivors do not upload or deform again merely because another entity spawned.

A failed GPU membership candidate does not roll back the CPU world. Its old attachment remains allocated, but rendering rejects the uncommitted membership revision. Remove/fix the rejected addition, evaluate the world and synchronize again. A rendering device failure still follows the existing renderer failure policy rather than this recoverable membership policy.

## Verification and allocation baseline

CPU tests cover candidate slot isolation, range reuse/coalescing, stale handles, retained private-resource leases, snapshot revisions and entity-ID replacement. Real GPU tests cover growth with stable surviving handles/outputs, reclaimed-slot writes deferred until commit, failed additions, selective release, no-op/held synchronization, continued joint overrides, deformation against the CPU reference, empty-world cleanup and delayed visibility results across slot reuse. Existing world regressions cover authored lights, bounds, winding, shadows, transparency and phase ordering.

Run `pnpm bench:membership` for 128 and 512 animated models. The [Phase 3 baseline](baselines/membership-phase3-2026-10-02.json) records browser/device, allocation counts, requested bytes and one warm preparation sample per operation. Spawning one fixture model allocates its 2 private output buffers in either workload; forced full attachment prepares 258 or 1,026 output buffers. Spawning into spare capacity allocates 520 requested buffer bytes and no transform binding. Initial growth also allocates a larger global transform binding. Both workloads end with zero tracked live GPU bytes after renderer destruction.

The full reference attaches a new CPU world using the same warm loaded assets to force complete private-state preparation. CPU world construction is excluded. Preparation samples include validation-scope completion; they are not GPU execution timings or statistically robust latency percentiles. Allocation counts are deterministic regression assertions, and requested byte totals are resource estimates rather than physical VRAM measurements.
