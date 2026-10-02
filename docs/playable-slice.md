# Phase 5 playable slice

Run `pnpm dev`, then open `http://127.0.0.1:5173/`. `pnpm build` emits the playable game as `index.html`; `pnpm preview` serves it at `/`. The former viewer is retained only as a GPU regression fixture and is excluded from production builds. The game generates its glTF character and level locally, without remote model downloads.

Move with **WASD or arrows**, hold **Shift** to run and press **Space** to jump. Explore the low steps and jump over the center barrier. **Pause/Resume** freezes physics and clip time. **Despawn/Spawn companion** exercises retained membership with a second independently animated instance. Click the canvas to restore keyboard focus after other controls. Desktop keyboard/mouse and WebGPU are the current targets; touch/gamepad and anime art are later work.

Phase 6 extends this slice: hold **E** for an additive arm pose and select **Use authored root motion** for collision-resolved clip travel. The footfall counter demonstrates authored events. Toon ramps and hull outlines style the original character; see [animation contracts](gameplay-animation.md) and [presentation limits](anime-presentation.md). Player animation now advances on fixed gameplay steps; the companion retains presentation playback. Retargeting/IK and production anime assets remain separate work.

## Code and ownership

| Module                          | Responsibility                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `engine/input/actions.ts`       | Action states, binding aliases, simulation-consumed edges                           |
| `engine/physics/contracts.ts`   | Backend-independent character intent and fixed-step lifecycle                       |
| `engine/physics/rapier.ts`      | Optional WASM backend; import directly rather than through the engine barrel        |
| `engine/physics/entity-pose.ts` | World-space feet to physics-owned entity-local translation                          |
| `game/assets.ts`                | Original glTF character with limb animations and breathing morph target             |
| `game/level.ts`                 | Level with identical visible/collider box dimensions and shared character resources |
| `game/locomotion.ts`            | Normalized movement and Idle/Walk/Run crossfade policy                              |
| `game/simulation.ts`            | Gameplay intent followed by the registered physics controller system                |
| `game/keyboard.ts`              | DOM input, focus behavior and listener cleanup                                      |
| `game/main.ts`                  | Startup, camera/rendering, pause, membership boundary and disposal                  |

Both characters share `LoadedModel` geometry, materials and prepared clips. Each retains its own controller, pose and mutable GPU morph output. Physics owns the player entity root, so gameplay writes fail instead of competing. Facing uses an explicit model-root node override; animation owns limb rotations and breathing weights. This placeholder has rigid animated limbs and a morph target, not retargeted skeletal anime art.

```text
keyboard events → buffered actions
fixed gameplay → consume one snapshot, choose velocity/clip/facing
fixed physics → collision movement, shared world step, publish entity root
presentation → animation and dirty world hierarchy evaluation
explicit renderer call → pose upload → compute → shadows → color → tone mapping
```

The runtime stays CPU-only. The application owns RAF, the renderer, physics world and registry. Its two systems use default 60 Hz fixed steps. Pressed/released edges survive zero-step frames, then appear only in the first consuming step. Repeated keydown creates no new edge; W/ArrowUp retain separate sources. Diagonal and axial speeds match. State transitions fade once, preserving clip clocks while remaining in a state.

## Parent transforms and suspension

Physics capsule placement is authoritative in world coordinates. Call `world.updateTransforms()`, inspect `world.getParent(entity.id)`, then `writePhysicsPosition(entity, feet, parent)`. The helper applies the inverse parent matrix and writes as `physics`. Translated, rotated and nonuniformly scaled invertible parents support **position conversion**; singular parents reject. Reparenting/parent movement changes local coordinates while the physics world position remains authoritative on the next fixed step. A handoff requires `entity.setTransformOwner(...)` and corresponding controller teardown/recreation.

The upright capsule adapter publishes translation only. It does not convert arbitrary rigid-body rotations, inherit visual scales into collider dimensions, or implement gameplay teleport/reconciliation. The level's player is unparented, upright and unit-scale. Tilted/scaled visual characters need a deliberate orientation/collider policy before extending gameplay.

Manual pause, hidden-tab suspension and async membership preparation pause the runtime. Resume reanchors the wall clock, preventing hidden time from accumulating physics or fast-forwarding clips. Input clears at these boundaries and on blur; held keys must be pressed again. Existing catch-up limits bound long frames. Camera damping uses accepted presentation time and follows resolved world placement.

The app stops GPU submissions until `renderer.syncWorld(world)` commits companion membership. Player handle, pose, clip time and compute allocation remain retained; the new companion receives a fresh pose. Failed preparation shows an error and disposes the session. Page exit or HMR cancels RAF/listeners, disposes systems/character, frees WASM physics, destroys GPU resources and clears CPU caches.

## Verification and scope

`pnpm test` covers action edges/aliases, rate independence with real WASM physics, walls/stairs/jump, pause, parent conversion/ownership and independent animation state. `pnpm test:browser:offline game.spec.ts` checks keyboard movement, jumping, manual/hidden pause, viewport changes and companion actions. The GPU test reads compute output bytes and compares player pose revision, clip time, stable handle and output allocation across companion removal/recreation. The full offline viewer suite is the regression gate.

See [backend evaluation and measured bundle cost](physics-backend.md). The slice provides the first playable character loop. Combat/objectives, editor, touch/gamepad, runtime collider edits and physics interpolation remain unimplemented. Spatial audio, saves, inspection and device-loss recovery now have the Phase 7 foundations. Physics placement is displayed at the fixed-step position; player animation advances with gameplay, while camera damping uses accepted presentation time.

After building, `pnpm test:compressed-build` also smoke-tests the emitted game page, WASM initialization, movement, pause, companion membership and shipped license alongside the existing production decoder regressions.

## Bootstrap and session refactoring

The second post-migration refactoring step splits the application by ownership:

| Module                 | Responsibility                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `game/main.ts`         | Validate/mount the page and register HMR disposal                                    |
| `game/session.ts`      | Startup, owned resource teardown, RAF, pause, membership and recovery boundaries     |
| `game/restore.ts`      | Safe pending-save consumption, world loading and restoration after gameplay defaults |
| `game/presentation.ts` | Follow camera, companion event disposal, tooling/audio update and explicit rendering |
| `game/controls.ts`     | Required page elements, keyboard/control bindings and button state                   |
| `game/simulation.ts`   | CPU gameplay/physics systems with idempotent character disposal                      |

Create `new GameSession(gameElements(document))`, then await `start()`. Call `destroy()` for page/application teardown, including while startup is pending. A session starts once; create another session for a remount. The entry point handles rejected startup promises because the session already displays the failure and cleans up. It registers HMR disposal before startup, so pending initialization is included in that lifetime.

Blocked storage cannot stop a fresh launch. Invalid saves still fail with a visible startup diagnostic rather than silently discarding incompatible content. Restore captures player playback before `CharacterSimulation` establishes its defaults and reapplies the saved body/gameplay policy before the first runtime frame. Physics/gameplay stays independent of storage and DOM; renderer phase ordering and retained instance behavior remain unchanged.

CPU session tests keep real worlds/poses/systems while substituting backend/browser lifetime boundaries. They cover storage access/removal failure, malformed saves, restored playback, initialization and binding failure, late-resource disposal, idempotent cleanup, simultaneous membership/recovery pauses, and remounts during canceled GPU startup/recovery. Real browser tests cover the playable page under blocked session storage and normal movement/pause/companion/save/reload behavior. The full offline GPU suite and production startup smoke test remain regression gates.
