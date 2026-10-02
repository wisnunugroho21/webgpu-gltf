# Editor commands and content-driven backends

Refactoring part 6 adds a headless `WorldEditor` command service, opt-in versioned component schemas and explicit game backend factories. The contracts cover the existing character playground: player/companion actors, axis-aligned static box collisions, saved kinematic character movement and a synthesized mono footstep. Scene entities, asset references and registered components remain the data model; this step does not replace their services with an ECS.

## Command boundary

Import `WorldEditor` and `EditorCommand` from `src/index.ts` (or the CPU-only `src/engine/index.ts`). Commands support:

| Command            | Supported mutation                                                            | Undo data                                                     |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `set-transform`    | `Entity.setTransform` with a partial local TRS patch                          | Previous full local TRS                                       |
| `set-component`    | Validated, copied component JSON                                              | Previous value or absence                                     |
| `remove-component` | Supported component removal                                                   | Previous value or absence                                     |
| `membership`       | One ordered atomic `World.applyChanges` batch of create, reparent and destroy | Structural inverse plus removed instances' playback/overrides |

`execute`, `undo` and `redo` return `{ membershipChanged }`. Commands do not run simulation, evaluate hierarchies, load assets, synchronize GPU membership or render. An application adapter owns the paused edit boundary:

```ts
const editor = new WorldEditor(world);
editor.select(['companion']);

// The application has paused simulation and submissions for this edit.
const result = editor.execute({
  type: 'set-transform',
  id: editor.selection[0],
  patch: { translation: [3, 0.02, 3] },
});
world.updateTransforms();
if (result.membershipChanged) await renderer.syncWorld(world);
renderer.render(presentationTimeMs, camera.view(renderer.aspectRatio));
// Resume through the application's existing pause policy.
```

Use the same adapter sequence for undo/redo. A batch can create a parent after its child, reparent surviving children out of a deleted subtree, or replace an entity with the same ID. New entity initialization, including restored playback and explicit node overrides, occurs while the candidate is private. Initializers supplied to `World.applyChanges(changes, initialize)` must only initialize the provided unpublished entity, with no external resource/side effects. An initializer or final hierarchy validation failure leaves live membership unchanged.

Survivors retain Entity/ModelInstance identity and GPU handles/output through synchronization. Undoing deletion recreates private Entity/ModelInstance state using shared loaded assets; it restores current animation checkpoints and overrides but cannot resurrect destroyed GPU buffers or external physics/audio objects. Removed entities' definitions and per-model state are detached history data. The inverse detaches survivors before removing added parents, including same-ID parent replacements.

Physics still owns physics roots. Editor transforms cannot impersonate that writer; an application must explicitly hand ownership to gameplay for a placement edit and later synchronize/rebuild the body before handing it back. Reparenting is local-space and does not preserve world placement automatically. Node override/clip gizmos, multi-transform drag coalescing and a graphical editor are further authoring features, outside this command surface.

## History, selection and failure

History defaults to 50 entries, configurable from 1 to 256. Entry count bounds history, not total bytes for arbitrary models. A new edit discards redo; a no-op preserves it. Selection validates all IDs before assignment, returns copies and drops removed IDs. Structural ordering may differ after undo, while IDs, parents, content and surviving identities retain their meaning.

A copied scene fingerprint plus Entity identities detects external transform/component/ownership/membership changes, including a same-ID replacement with identical JSON. Commands and replay reject stale history instead of overwriting the external edit. `clearHistory()` explicitly adopts the current world. Animation clocks and internal pose overrides are independently owned and do not invalidate this authored-state fingerprint; membership inverses capture their latest state at the operation boundary. Schema parsers/migrations must be pure and deterministic.

Fingerprinting scans scene definitions on editor operations, and structural undo preparation captures model checkpoints/overrides before publishing a batch. This is a deliberate correctness boundary for the small authored playground, not a per-frame or large-scene optimization. Further indexing requires measurements on representative editor content.

CPU command success and GPU preparation are separate transactions. If `syncWorld` fails, keep submissions paused and repair/retry the CPU world using the existing membership policy; do not resume against the old attachment. Backend collision/character objects likewise belong to the adapter, never history.

## Versioned content and export

`ComponentRegistry.registerVersioned(key, schema)` wraps the existing copied validation path. A positive target `version` is required, future/malformed versions reject, and missing versions denote legacy version 0. Older payloads require an explicit `migrate(value, fromVersion, path)` returning the target version before parsing. Both migration and parse output remain finite copied JSON; parsers must preserve the target version. Existing `register` schemas and unknown-JSON preservation remain compatible.

The playground registers two version-1 schemas in `game/components.ts`:

- `game.actor`: a `player` or `companion` role, visible in inspection and preserved through edits/saves.
- `game.colliderBox`: three positive local half extents. The generated unit box uses `[1, 1, 1]`; evaluated entity scaling determines world extents.

Fresh scenes and saved-world restoration use the same registry. Older playground saves lacking both actor and collider metadata still load; the restore adapter opts into the original eight `level-0` through `level-7` entities' legacy unit-box shapes. Normal collision installation uses explicit components, so removing a collider component from current authored content removes that shape when installing a fresh backend. Future component versions are rejected before publication/GPU startup.

`editor.exportScene()` returns the existing validated flat SceneDocument version 1 with referenced asset URIs. glTF assets retain the loader's glTF 2.0 validation and shared LoadedModel contracts. Use stable/versioned content URIs when publishing revisions; changing a registry binding behind an attached instance is unsupported. AuthoringScene version 2 prefab templates/instances stay in the application's source document; runtime export does not recover their provenance or edit templates. Keep that source separately, as with runtime saves, and use `parseSceneDocument`/`World.fromDocument` for round-trip validation with the same component schemas and loaded declarations.

## Backend extension surface

The existing `PhysicsAdapter` and `AudioBackend` remain small base contracts. Two optional interfaces express capabilities this game's content actually consumes:

- `CheckpointPhysicsAdapter` returns `CheckpointCharacterBody`, whose required `checkpoint`/`restore` use the shared `CharacterCheckpoint` shape. The base character API keeps these optional for applications without saves. Rapier implements the extension; gameplay and save tooling no longer assert that optional methods exist.
- `PcmAudioBackend` adds `registerPCM` to the spatial voice/listener/resume/suspend lifetime contract. Web Audio implements it. Encoded clips, buses and other capabilities can have separate content-driven interfaces later.

`game/backends.ts` defines `GameBackends` with `createPhysics(): Promise<CheckpointPhysicsAdapter>`, `createAudio(): PcmAudioBackend` and optional `AssetRegistryOptions`. Pass an implementation to `new GameSession(elements, backends)` to replace services. Browser defaults still use Rapier/Web Audio. Factories transfer ownership on success, clean up their own failed construction, and return backends with idempotent `destroy()`. Late physics results after canceled startup are released by the existing session acceptance path. Asset resolver cancellation/decoding limits keep their existing registry contracts.

Audio construction occurs only from the Enable audio gesture. GameTools registers the original PCM footstep through the interface, without importing the browser backend. Disposal clears ownership before release; late resume/suspend failures cannot release a disposed backend again or write into a disposed page.

`createLevelWorld()` constructs CPU content. `installLevelCollisions(world, physics)` validates every box before allocating on a fresh backend, after the chosen scene/save has been evaluated. GameSession therefore uses edited/restored box positions instead of creating collision from the initial template first. `createLevel(physics, assets)` remains a convenience wrapper for existing callers. Install collisions once per fresh backend; it is not an incremental collider update service. Live editing of box membership/transforms requires the host to recreate/reconcile physics before gameplay resumes. Rotated/sheared boxes and collapsed/overflowing extents reject clearly until the backend supports corresponding shapes.

## Verification

CPU tests cover revision propagation, detached command data, versioned/unknown component round-trips, history limits/noops/selection, stale history, physics ownership, subtree inverses, same-ID parent replacement, playback/overrides and failed candidate initialization. Backend tests exercise injected session acquisition/cleanup and gesture-driven audio with a late failure after disposal. Collision round-trips check edited transforms, legacy saves and rejection before allocation.

The real WebGPU editor regression edits the generated companion, deletes/undoes it through an explicit adapter boundary and checks restored state, retained player handles and GPU output buffers. Existing world/membership/recovery, game movement and production startup tests continue to protect renderer phases and session lifetimes.
