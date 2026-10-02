# Asset, component and system services

Phase 4 introduces CPU services under `engine/assets/`, `engine/components/` and `engine/systems/`. `ModelLibrary` now extends `AssetRegistry`; existing `register()`, `get()`, `getModel()` and `references()` calls remain supported. Gameplay worlds accept either class. These services do not import renderer internals or schedule browser frames.

## CPU asset registry

```ts
import { AssetRegistry, loadUrl, loadWorld } from './src';

const assets = new AssetRegistry({
  resolve: (uri, id, signal) =>
    loadUrl(new URL(uri, sceneUrl).href, {
      signal,
      textureCompression: renderer.textureCompression,
    }),
});
assets.declare('hero', 'models/hero.glb');
const controller = new AbortController();
const model = await assets.load('hero', { signal: controller.signal });

const lease = assets.retain('hero'); // Pins registry cache retention.
lease.release(); // Idempotent.
assets.evict('hero'); // Drops this ID's cache retention; keeps its URI declaration.
await assets.load('hero'); // Reloads if no loaded alias still retains that URI.

const world = await loadWorld(sceneDocument, undefined, { assets, components });
```

`sceneUrl`, `renderer`, `sceneDocument` and `components` are supplied by the application. The default resolver uses the browser glTF URL loader. Pass a custom resolver for headless/in-memory use, URI resolution or device texture capabilities. A registry has one resolver; when sharing it with `loadWorld`, configure the registry instead of also passing a scene resolver. The legacy `loadWorld(document, resolver)` signature still works and gives its resolver an optional-use third AbortSignal argument.

Declarations bind stable IDs to exact URI strings. Declaring the same ID/URI is idempotent; a conflicting URI rejects. `register(id, asset, uri)` installs already-loaded data and preserves duplicate-ID rejection. Same-URI pending requests share one transport/decode, including requests from separate scenes and alias IDs. The resolver receives the first subscriber's ID; resolvers whose behavior differs by ID must use distinct URIs. Canonicalize URLs in declarations when equivalent spellings should deduplicate. Aliases receiving the same Asset object share a LoadedModel and prepared clips even across different URIs.

Each `load()` call subscribes independently. Aborting its signal rejects only that caller. `cancel(id)` rejects this ID's pending callers while other aliases continue. The underlying controller aborts when its final subscriber leaves. A cancelled or failed request is removed immediately so the next load can retry. A custom resolver that ignores cancellation may finish later; its obsolete result cannot overwrite a fresh request. Default glTF loading aborts fetches and checks its signal between decode stages and before publication. An already running decoder operation finishes cooperatively; this API does not promise immediate worker preemption.

`AssetLoadError` carries assetId, URI, code and cause. Messages identify `assets["id"]`; cancellation errors have name `AbortError`. `inspect(id)` returns copied/frozen status metadata, subscriber count, CPU pins and the latest diagnostic. It does not expose GPU memory or mutable registry storage. Failed records retain a diagnostic until retry or eviction rather than caching a failed Promise permanently.

`acquire()` combines loading and a CPU retention lease; `retain()` pins an already-loaded record. `evict()` rejects while pinned, cancels this ID's pending callers and clears its cached model without removing the declaration. Other loaded aliases can retain the same URI/model. `forget()` also removes the ID/URI declaration; use it only when that reference is no longer needed for scene creation or serialization. `destroy()` cancels all pending subscribers, drops cache/declarations and rejects future registry operations. Leases can still release after disposal.

CPU eviction/disposal drops registry references, not live instances' references. Existing instances keep their LoadedModel, pose and playback; renderer-private outputs and shared device leases remain valid until renderer membership removal/disposal. No CPU service closes data needed by live instances or calls GPU destroy. ModelLibrary assets are still treated as immutable. Cache eviction is not forced destruction of every external reference; JavaScript retains data while any instance/client holds it.

`loadWorld()` validates the entire version-1 scene and registered components before starting asset loads. It can share a registry and accepts an AbortSignal. Scene failure cancels that scene's subscriptions, leaving unrelated registry subscribers alive, and publishes no World. A shared registry can retain successfully loaded assets/declarations after another scene asset fails; callers can retry or evict them. A scene-owned registry is disposed on failure. Scene JSON remains the authoring format rather than embedding bytes or playback state.

## Component schemas and typed access

```ts
import { ComponentRegistry, World } from './src';

interface Health {
  current: number;
  max: number;
}
const components = new ComponentRegistry(); // Unknown JSON is preserved.
const health = components.register<Health>('health', {
  parse(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.current !== 'number' ||
      value.current < 0
    ) {
      throw new Error('current must be a nonnegative number');
    }
    const max = typeof value.max === 'number' ? value.max : 100;
    if (value.current > max) throw new Error('current exceeds max');
    return { current: value.current, max };
  },
});
const world = new World(assets, components);
const player = world.createEntity({ id: 'player', components: { health: { current: 80 } } });
const value: Health = player.requireComponent(health);
player.setComponent(health, { ...value, current: 70 });
```

Schemas parse JSON into serializable values and may supply defaults. Keep parsers pure and idempotent: validation runs on load, construction, reads, writes and serialization. Register schemas before loading scenes when possible. Parser input/output is copied and finite, acyclic JSON is enforced even for typed interfaces. Non-JSON class instances and asynchronous parser results reject.

A registered handle gives typed `getComponent(type)`, `requireComponent(type)`, `setComponent(type, value)` and `removeComponent(type)` access. Optional reads return undefined when absent; `requireComponent()` identifies a missing component's entity/key path. Handles belong to their registry, so a same-named handle from another registry rejects. String access remains available and applies any registered schema. Failed writes leave previous data intact; getter copies cannot mutate stored state. Late schema registration cannot turn previously unknown invalid data into an unchecked typed read.

The default unknown policy is `preserve`: unknown names and JSON data round-trip unchanged without automatic gameplay behavior. `new ComponentRegistry('reject')` requires every component to have a registered schema. Strict mode fails before loading assets for scene data, and before publishing invalid entities/structural batches. ComponentValidationError retains the exact entity/component path and cause. `parseSceneDocument(document, components)` and `World.fromDocument(document, assets, components)` apply the same policy. Schema registrations are application configuration, not persisted executable code; the scene format remains version 1.

## Ordered CPU systems

```ts
import { EngineRuntime, type EngineSystem } from './src';

const movement: EngineSystem = {
  id: 'movement',
  phase: 'gameplay',
  order: 10,
  initialize: ({ world }) => {
    /* Allocate this system's CPU state. */
  },
  fixedUpdate: ({ world }, step) => {
    const player = world.getEntity('player');
    // Use supported entity setters and the current gameplay/physics writer.
    const position = player.transform.translation;
    position[0] += speed * step.deltaSeconds;
    player.setTransform({ translation: position });
  },
  destroy: () => {
    /* Release this system's CPU state. */
  },
};
const runtime = new EngineRuntime(
  world,
  {
    present: (frame) =>
      renderer.render(frame.presentationTimeMs, camera.view(renderer.aspectRatio)),
  },
  { systems: [movement] },
);
```

`speed`, `camera` and rendering services belong to the application. A fixed system uses `fixedUpdate()` in the `gameplay` or `physics` phase. A `presentation` system uses `presentationUpdate(context, frame)` for interpolation/overrides and runs once per accepted frame, including held/paused frames. Systems run in phase order, ascending numeric order within a phase, then registration order for ties. Their callbacks precede the legacy hook of the same phase. Visual animation/root evaluation follows presentation systems/hooks; the application's present hook runs last.

The runtime captures schedule metadata and bound callbacks at construction, supporting class-based systems without losing their receiver. Duplicate IDs, invalid phases/orders and callbacks for the wrong phase reject. Initialization occurs once before the first advance/input callback. Destruction runs in reverse initialization order, once; systems never initialized receive no destroy call. Initialization failure also cleans the failing, partly initialized system. Cleanup continues after errors and reports an AggregateError. All callbacks are synchronous; thenables reject with system/phase context, and reentrant advance rejects.

The schedule is fixed for a runtime's lifetime. Runtime destruction disposes its systems, not its caller-owned World, registry or renderer. Existing hooks, fixed-step limits, pause/resume and explicit camera/render ownership remain supported. This is a small ordered service interface, not an ECS, dependency-graph scheduler or automatic component query engine. Systems that spawn/despawn still require the explicit rendering membership boundary described in [retained membership](rendering-membership.md).

## Verification

CPU regressions cover same-URI/scene deduplication, independent instance state, cancellation isolation and final-subscriber abort, retry and late results, cache leases/eviction/disposal, schema/default/copy behavior, strict unknown policy, atomic entity failures, late registration, class callbacks, phase order, initialization rollback and reverse cleanup. A real GPU services regression confirms shared definitions/clips, independent pose/playback, registry eviction without GPU buffer replacement, and gameplay updates before render. Existing resource lifetime, deformation, material binding and viewer suites continue to protect integration.
