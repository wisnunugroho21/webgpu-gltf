# Game engine restructuring and refactoring plan

## Goal and first playable milestone

Evolve the current renderer into a browser game engine through small, verified changes. The first milestone is a third-person character moving through a small level with collision, a follow camera, idle/walk/run animation, and spawn/destruction of another character sharing the same model resources. Keep the glTF viewer working throughout migration. Anime-specific rendering follows this milestone so it can be evaluated in an actual game scene.

This document combines implemented migration phases with the remaining plan. APIs, modules and systems in unfinished phases are proposals. The [current review](review-2026-10-02.md) records existing capabilities and verification.

Phases 0–7 foundations are implemented: safeguards, engine-owned updates/cameras, scalable hierarchy, retained membership, services, the playable slice, and gameplay animation/toon presentation. See [runtime](engine-runtime.md), [migration safeguards](migration-safeguards.md), [hierarchy](world-hierarchy.md), [membership](rendering-membership.md), [services](engine-services.md), [playable slice](playable-slice.md), [gameplay animation](gameplay-animation.md) and [anime presentation](anime-presentation.md) for APIs and limits. Phase 7 adds [authoring/saves](authoring-and-saves.md), [audio](audio.md) and [recovery/measurements](resilience-and-scale.md); an editor and larger rendering/streaming systems remain measurement-gated.

## Architecture and ownership contract

| Responsibility                            | Owner                          | Contract                                                         |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Clock, update order and lifecycle         | Engine runtime                 | Application starts/stops the runtime; renderer schedules nothing |
| Entity roots                              | Gameplay or physics            | One explicit writer; handoff preserves placement                 |
| Model node hierarchy                      | Animation                      | Gameplay/IK exceptions use explicit field overrides              |
| CPU model definitions and clip keys       | Asset registry / `LoadedModel` | Shared and treated as immutable                                  |
| GPU geometry, textures and materials      | Renderer model resources       | Device-specific, shared, leased                                  |
| Pose, playback and deformation output     | Individual model instance      | Independent even when assets are shared                          |
| Rendering membership and instance handles | Engine-to-renderer bridge      | Incremental, transactional updates                               |
| Bindings, passes and GPU submission       | Renderer                       | Upload → compute → shadows → color → presentation                |
| glTF content                              | Asset loader                   | Model format, not gameplay scene storage                         |
| Components, asset references and prefabs  | Engine serialization           | Versioned engine format                                          |

The dependency direction should become application → engine → renderer, with engine and renderer also using the CPU asset/animation modules. Core renderer modules should ultimately consume rendering descriptors instead of importing `World` or attaching DOM controls. A compatibility facade can preserve `setAsset`, `setWorld` and `render(timestampMs)` while translating old calls through adapters; it must not make core passes responsible for simulation.

Keep existing `gltf/`, `animation/`, `scene/` and GPU feature modules unless a concrete responsibility requires extraction. Do not implement a general ECS, editor framework or render graph before the first playable milestone establishes their requirements.

## Intended organization

```text
src/
  engine/
    runtime/          clock, fixed-step coordination, system order, lifecycle
    world/            entities, hierarchy, component registry, structural changes
    assets/           asset IDs, loading, CPU resource lifetime, diagnostics
    rendering/        world-to-render descriptors, incremental instance handles
    input/            action state and browser input adapter
    camera/           engine camera state and follow-camera behavior
    physics/          backend-independent contracts and integration adapter
    animation/        gameplay animation states, events and optional root motion
    audio/            emitter/listener interfaces and browser backend
    serialization/    scene versions, component schemas, prefabs and save state
  gltf/               model decoding and extension validation
  animation/          reusable clip sampling and mixing
  scene/              CPU pose/deformation math and revisions
  renderer/           device resources, visibility, GPU deformation, passes
  app/                existing viewer and its adapters
  game/               first playable example and game-specific behaviors
```

Create directories when implementing their responsibilities. Preserve public exports through existing barrels during moves; avoid creating empty modules or splitting cohesive classes into many forwarding classes.

## Phase 0 — Protect the migration

**Changes:** add a strict browser-test TypeScript configuration and a typed, read-only test inspection surface. Establish CI checks for build, formatting, CPU tests, production decoder loading and browser GPU tests where a supported runner exists. Keep network-dependent Khronos tests distinct from offline fixtures. Record small/medium/large scene CPU costs, requested GPU memory, allocations and scene preparation time.

**Starting files:** `tsconfig.json`, test configurations, architecture tests, browser test helpers and profiling/resource ownership code.

**Acceptance:** existing behavior passes; dependency tests guard CPU/GPU/application boundaries; benchmarks identify the device/browser and workload. GPU timings are optional and capability-detected; CPU timing must not be presented as GPU execution time.

## Phase 1 — Give the engine control of simulation and cameras

**Changes:** introduce engine-owned update coordination. Split world animation/transform evaluation from renderer upload preparation so rendering can consume already evaluated state. Move orbit input handling to a viewer adapter. Add camera data containing view/projection, eye position and viewport assumptions; support an engine follow camera without DOM listeners in core rendering.

**Starting files:** `renderer/renderer.ts`, `core/bindings.ts`, `render/pass.ts`, `camera/orbit-camera.ts`, `engine/world.ts`, `app/render-loop.ts` and the compatibility facade.

**Frame policy:** capture input; run bounded fixed simulation steps; produce presentation transforms; evaluate visual animation/overrides once using the engine's presentation clock; update model worlds and dirty revisions; pass the render view to the renderer. Cap catch-up work after suspension and define pause/resume behavior. Gameplay animation events and root motion, when introduced, belong to simulation time rather than whichever render frames happen to occur.

**Acceptance:** a world can simulate with no canvas; it can render twice without advancing simulation twice; rendering can be skipped without losing revisions. Viewer orbit/seek/resize still works. Gameplay and physics writes complete before uploads, and rendering does not discard dirty work evaluated earlier.

## Phase 2 — Make world hierarchy evaluation scalable

**Changes:** extract iterative parent-first traversal and child adjacency from `World`. Track entity local revisions, parent-world revisions and effective world revisions. Recompute only changed subtrees. Batch structural changes at an explicit boundary; reparenting and subtree destruction update traversal caches. Keep root-writer ownership and copied public getters.

**Starting files:** `engine/world.ts`, `engine/entity.ts`, transform validation and world tests. Move the existing classes into `engine/world/` only as their responsibilities are extracted.

**Acceptance:** deep hierarchies avoid recursion overflow; unchanged worlds perform no matrix recomputation or pose uploads; parent motion updates descendants, skins, lights, bounds and visibility. Wide/deep hierarchy benchmarks demonstrate the change. Failed hierarchy edits leave the previous hierarchy usable.

## Phase 3 — Retain rendering instances across world changes

**Changes:** introduce stable render instance handles, separate from entity IDs and glTF node indices. Retain surviving private deformation outputs and transform slots during spawn/destruction. Queue add/remove operations, prepare new resources transactionally, then commit without rebuilding every surviving instance. Move world-specific composition behind the engine rendering bridge; reuse `SceneData`, final instance binding and model-resource leases.

**Starting files:** `renderer/scene/world-builder.ts`, `builder.ts`, `types.ts`, `instance-binding.ts`, resource caches and an `engine/rendering/` bridge.

**Acceptance:** adding one entity prepares that entity's private state; unrelated handles/output buffers survive. Failed additions retain the active scene. Removed slots cannot be referenced by in-flight visibility readbacks; use generations or equivalent invalidation. Shared geometry/materials survive until their last consumer ends. Instance address updates preserve shadows, transparent sorting and selective deformation.

## Phase 4 — Add asset and component services

**Changes:** evolve `ModelLibrary` into a CPU asset registry with stable IDs, request deduplication, contextual diagnostics, cancellation/failed-load policy and explicit lifetime. Separate CPU cache retention from device resource leases. Add registered component schemas and typed access for known components while retaining versioned JSON and a clear policy for unknown data. Introduce a minimal system interface with explicit update order and lifecycle.

**Starting files:** `engine/model.ts`, `loaded-model.ts`, `load-world.ts`, `scene-document.ts` and `Entity` component storage.

**Acceptance:** multiple instances of one model share definitions/clips and GPU assets, with independent clocks/poses/output. Failed loads are retryable. Scene validation fails before publishing a partial world. Missing asset/component diagnostics identify their path. CPU systems remain independent of renderer internals. Full ECS storage/query optimization remains a measurement-driven decision.

## Phase 5 — Deliver the playable vertical slice

**Implemented:** `/` runs original local glTF characters/level through action input, registered gameplay/physics systems, the Rapier adapter and explicit follow-camera rendering. Parent-local position conversion, pause/suspension and retained companion membership have CPU/GPU coverage. See [implementation and limitations](playable-slice.md) and [backend evaluation](physics-backend.md), including measured bundle cost. The character uses rigid limb animation and compute morph breathing; anime assets/retargeting remain Phase 6 scope.

**Changes:** add action-based input, a physics integration adapter, collision shapes and a character movement/controller system. Define conversion between physics world poses and entity-local roots under parents. Add an idle/walk/run animation state machine and a follow camera. Create `game/` with one level and two instances of a character model.

Choose the physics backend in a separate evaluation covering browser/WASM loading, licensing, bundle cost, character-controller requirements and testability. Engine systems depend on the adapter contract rather than backend types. Do not build a general physics solver as part of the renderer refactor.

**Acceptance:** movement/collision behavior is stable across different rendering rates; input edges are consumed once; physics and gameplay cannot both write a root accidentally. Pause/resume and tab suspension behave predictably. A second character can spawn/despawn without resetting the first character's pose or GPU output. Viewer regressions continue passing.

This phase is the first “game engine” release gate: a complete playable loop built through supported engine APIs, with clear lifecycle and tests. Audio, editor tooling and large-scene rendering are not prerequisites for this gate.

## Phase 6 — Add gameplay animation and anime presentation

**Implemented:** fixed-step animation advancement, authored events, per-node masks, additive overlays, translation root-motion extraction/one-time consumption and in-place physics playback. The slice demonstrates aim overlays, footfall events, optional authored travel, toon ramps and original stylized hair/eyes. Material/frame layout migrations are explicit and all texture slots remain fixed. GPU fixtures cover skin/morph output, mirrored hulls, HDR, MSAA and transparent toon shading; hulls intentionally exclude transparent/transmitting surfaces and conservatively bypass unexpanded culling. See [animation contracts](gameplay-animation.md) and [presentation/limits](anime-presentation.md). Retargeting and IK remain separate additions through per-instance overrides.

**Changes:** add animation events, per-node masks and additive layers where the game needs them. Add explicit root-motion extraction/consumption, including in-place playback when physics owns movement. Retargeting and IK are separate additions, integrated through shared clips and per-instance overrides. Add toon material parameters, controlled lighting ramps and outlines as renderer features backed by authored scene/material data.

**Acceptance:** events are stable during looping, fading and catch-up simulation; root motion is applied once and does not fight physics. Upper-body overrides do not contaminate shared clips or animation interruption snapshots. Toon/outline features have visual fixtures for skinned meshes, mirrored roots, transparency, HDR and MSAA. Keep the explicit material binding contract consistent across variants; incompatible additions require deliberate layout versioning and migration.

## Phase 7 — Authoring, resilience and measured scale

**Implemented:** version 1 to 2 scene migration, placement-wrapper prefabs, independent runtime saves/checkpoints, spatial emitter/listener contracts and a Web Audio backend, copy-only world/GPU inspection, deliberate device reconstruction with asset reupload and generation invalidation, optional pass timestamps, startup-inclusive requested memory and explicit allocation budgets. The playable example demonstrates save/reload, audio activation and inspection. CPU/GPU tests cover migration, restore, scene unload, budget rollback, retry and cancellation. Small/medium/large and actual playable-resolution baselines are checked in. Validation is confirmed on Edge/Intel; the alternate Chromium binary failed to launch in this environment, so cross-browser/GPU matrix completion remains external verification. See [contracts and measured boundaries](resilience-and-scale.md).

**Changes:** add prefabs and scene-format migrations, runtime save state separate from authoring scenes, audio emitters/listeners, inspection tools and later an editor. Implement deliberate device-loss recovery and asset reupload. Expand GPU memory/timing diagnostics. Add resource budgets/streaming, LOD, clustered lighting, cascaded shadows or GPU visibility only against representative measured workloads.

**Acceptance:** saved content survives documented format migrations; reload reproduces intended gameplay state; unloaded scenes release resources; device recovery reconstructs the current world without stale handles. Cross-browser/GPU validation and representative timing/memory baselines support rendering changes.

## Execution and completion rules

Implement each phase as small reviewable changes. Preserve the viewer, shared immutable inputs, independent mutable outputs, transform ownership and GPU pass order at every step. Keep temporary compatibility code in adapters with documented removal conditions. Update comments, README examples and architecture diagrams when ownership changes; do not describe proposed features as supported.

Use CPU tests for hierarchy, clocks, ownership, serialization and systems. Use real GPU tests for resource lifetime, deformed output, bindings, bounds/visibility and rendered appearance. Repeat relevant checks after changes; broaden testing when new behavior or failures justify it. Establish performance acceptance from measured baselines rather than arbitrary FPS targets.

All migration phases now have implemented runtime foundations. Next, choose actual game content and concrete editor/streaming requirements, then measure before expanding frameworks. A scene editor, automatic streaming, LOD, clustered lighting, cascades and GPU visibility remain gated follow-up work. Phase 6's translation-only extraction, conservative outline culling and transparent-shell policy remain explicit boundaries for subsequent work.
