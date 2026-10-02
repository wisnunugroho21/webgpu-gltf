# Authoring scenes and runtime saves

Authoring describes assets, components and starting placement. Runtime saves describe an evaluated world, independent model playback and game/backend state. Keep the original authored document separately: `World.toDocument()` deliberately flattens current entities and writes the compatible version 1 scene format. It does not reconstruct prefab inheritance or animation state.

## Scene migration and prefabs

`migrateScene(value)` accepts JSON or an object, copies it and upgrades a version 1 flat scene to version 2 with empty `prefabs` and `instances`. Entity IDs, asset URIs, transforms, owners and component JSON survive unchanged. Unknown versions and fields fail. `parseSceneDocument`, `loadWorld` and `World.fromDocument` accept both versions and return/use a validated flat version 1 representation. No existing scene requires rewriting.

```ts
const authored = {
  version: 2,
  assets: { character: '/models/character.glb' },
  entities: [{ id: 'level' }],
  prefabs: {
    actor: {
      entities: [
        { id: 'visual', model: { asset: 'character' } },
        { id: 'attachment', parent: 'visual', components: { tag: 'hand' } },
      ],
    },
  },
  instances: [
    { id: 'player', prefab: 'actor', parent: 'level', transform: { translation: [0, 0, 3] } },
    { id: 'npc', prefab: 'actor', transform: { translation: [2, 0, 3] } },
  ],
};
const world = await loadWorld(authored);
// Wrapper: player. Independent model entity: player/visual.
```

Each instance creates a placement wrapper and prefixes template-local IDs with `instanceId/`. Template roots become children of the wrapper, retaining authored local transforms. All parent/cycle, component and asset validation completes before publication, including validation of unused templates. Expanded IDs colliding with another entity fail. Components and transforms are copied; loaded assets remain shared. Templates use ordinary entity definitions, without nested prefab instances, inheritance or merge overrides.

For runtime spawning, use `world.applyChanges(expandPrefab(template, instance).map(entity => ({ type: 'create', entity })))`, then evaluate transforms and await `renderer.syncWorld(world)`. This uses the same atomic structural boundary as ordinary spawn batches. Removing the wrapper removes its whole subtree. Editing an already expanded entity uses supported transform/component APIs and does not edit its source template.

## Runtime save contract

```ts
const saved = captureSaveState(world, runtime, { quest: 'started', seed: 42 });
const json = JSON.stringify(saved);
const restored = await loadSaveState(json, { assets: sharedAssets, components });
// Reconstruct application systems/physics from restored.gameplay before continuing.
const nextRuntime = new EngineRuntime(restored.world, {}, { stepMs: restored.runtime!.stepMs });
nextRuntime.restore(restored.runtime!);
await renderer.setWorld(restored.world);
```

Save version 1 has `kind: 'engine-save'`, a flattened `scene`, an exact entity-ID keyed `models` table, optional `runtime` and finite JSON `gameplay`. Runtime checkpoints preserve fixed-step time, fractional accumulator and pause; wall timestamps are discarded to prevent catch-up across loading. The configured fixed step must match. Capture at an idle frame boundary, outside system callbacks. Recreate the systems needed by your game; the example above omits them for brevity.

Each model checkpoint includes absolute and additive layers, masks, clocks, overlay times, root-motion policy, pending displacement/events and active transitions, including interruption snapshots. Node overrides are separate from clips. Previously consumed events/travel are absent; pending items remain available exactly once. Restoring validates clips, snapshot shapes and node overrides against the loaded model. Asset contents must remain compatible with the saved definitions; this format does not promise cross-revision retargeting. CPU definitions and GPU allocations never enter the save.

`loadSaveState` builds a private candidate world and restores it before returning. Failure cannot partially edit a currently active world. With a shared asset registry, failure leaves that registry's cache under the caller's ownership. An internally created registry is destroyed on failure. Install the same component schemas when loading. Backend physics, gameplay policies, audio clocks, input, camera smoothing, RNG and quest state are application-owned and belong in `gameplay` when persistence is needed.

The playable example stores a save in localStorage; **Load save** reconstructs the page and physics backend. It preserves player placement, companion membership, footfalls, root-motion policy, locomotion and Rapier character vertical velocity/grounded state, alongside all model checkpoints. Original level colliders are recreated from the local level definition. It does not persist arbitrary edited colliders, input holds, camera smoothing or audio activation. Storage errors report without stopping play. Audio requires another gesture after page reload.

## Inspection and editing

`inspectWorld(world)` returns copied entity definitions, matrices, revisions, hierarchy statistics, animation policy and asset diagnostics. Mutating a snapshot does not edit the world. `/game.html` combines this with `renderer.diagnostics` in an inspection panel refreshed at most four times a second while open. Use `Entity.setTransform`, registered components and model overrides for changes; physics-owned roots still require physics handoff/writes. A visual scene editor, undo/redo and prefab authoring UI remain later tools built on these contracts.
