# Phase 5 playable slice

Run `pnpm dev`, then open `http://127.0.0.1:5173/game.html`. `pnpm build` emits both `game.html` and the existing viewer `index.html`; `pnpm preview` serves both. The game generates its glTF character and level locally, without remote model downloads.

Move with **WASD or arrows**, hold **Shift** to run and press **Space** to jump. Explore the low steps and jump over the center barrier. **Pause/Resume** freezes physics and clip time. **Despawn/Spawn companion** exercises retained membership with a second independently animated instance. Click the canvas to restore keyboard focus after other controls. Desktop keyboard/mouse and WebGPU are the current targets; touch/gamepad and anime art are later work.

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

See [backend evaluation and measured bundle cost](physics-backend.md). The slice provides the first playable character loop. Combat/objectives, audio, editor, device-loss recovery, touch/gamepad, runtime collider edits and physics interpolation remain unimplemented. Physics placement is displayed at the fixed-step position; animation and camera are independent presentation consumers.

After building, `pnpm test:compressed-build` also smoke-tests the emitted game page, WASM initialization, movement, pause, companion membership and shipped license alongside the existing production decoder regressions.
