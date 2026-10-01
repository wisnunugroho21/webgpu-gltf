# Gameplay entities and glTF model ownership

An entity is a string-identified gameplay object with a transform, optional parent, component data and optional model reference. A model instance contains the glTF asset's own nodes, joints, materials, morphs and lights. There is no entity for every glTF node. Entity IDs never depend on model node ordering or the number of meshes in a model.

`ModelLibrary` resolves stable asset IDs to loaded assets and source URIs. Register an asset once, then instantiate it on any number of entities. Loaded CPU asset bytes/definitions are reused; each `ModelInstance` has independent mutable pose arrays and an animation controller. Treat loaded asset definitions as immutable. This implementation still prepares GPU geometry/material resources per model instance; a shared GPU asset cache can be added behind this boundary later.

## Scene document

```json
{
  "version": 1,
  "assets": {
    "hero": "models/hero.glb"
  },
  "entities": [
    {
      "id": "party",
      "transform": { "translation": [10, 0, 0] }
    },
    {
      "id": "player",
      "name": "Player",
      "parent": "party",
      "model": { "asset": "hero" },
      "transform": {
        "translation": [0, 0, 0],
        "rotation": [0, 0, 0, 1],
        "scale": [1, 1, 1]
      },
      "components": {
        "health": { "current": 100, "max": 100 },
        "controller": { "speed": 4 }
      }
    },
    {
      "id": "npc",
      "model": { "asset": "hero" },
      "transform": { "translation": [3, 0, 0] }
    }
  ]
}
```

These model URIs are illustrative; supply your own GLB/glTF files. `version` is the engine format version, separate from glTF's version. Translation defaults to zero, rotation to the identity quaternion and scale to one. Rotations normalize; zero rotations, zero scale, nonfinite/out-of-range values, unknown structural fields, duplicate IDs, missing references/parents and cycles are rejected. Parent entities may appear later in the file. Component values must be finite, acyclic JSON; arbitrary component names/data round trip without requiring glTF extensions. Components hold data for application systems, not executable behaviors or an implemented physics integration.

```ts
import { loadWorld, loadUrl } from './src';

const sceneUrl = new URL('levels/party.scene.json', location.href);
const document = await (await fetch(sceneUrl)).json();
const world = await loadWorld(document, (uri) =>
  loadUrl(new URL(uri, sceneUrl).href, {
    textureCompression: renderer.textureCompression,
  }),
);
await renderer.setWorld(world);
renderer.render(0);
```

The resolver runs once per asset ID, regardless of entity count, and can use a local/in-memory asset source. Default loading resolves model URIs relative to the browser page; a custom resolver as above makes them relative to the scene file. Validation happens before asset loads. A loader failure publishes no world. For already-loaded assets, use `World.fromDocument(document, library)`; declared URIs must match that library's references.

Save with `JSON.stringify(world.toDocument(), null, 2)`. Saving records gameplay IDs, parent relationships, root transforms, model URIs and components. It excludes glTF payloads, GPU buffers and current animation clocks/poses. Add application-specific save-state components if those runtime states must persist. Definitions and getters copy JSON/transform values so caller mutation cannot silently change the world.

## Runtime and rendering

Use `world.createEntity(definition)`, `world.getEntity(id)`, `entity.setTransform(patch)`, `world.setParent(id, parentId?)`, and `world.destroyEntity(id)`. Destroying an entity removes its gameplay subtree; unrelated entities and loaded models remain. Reparenting preserves local transform values. Entities without models can hold gameplay data or group other entities.

Entity transforms are outside the model's authored defaults and animation hierarchy. Entity world matrices multiply model roots, including skin joints and lights. A clip switch or authored-pose reset cannot overwrite gameplay placement. Use `entity.model.animation` for independent playback. `Renderer.animation` and its forwarding methods alias the first world model for compatibility, while the single-asset viewer retains its existing behavior.

Gameplay/physics writes entity transforms before `renderer.render(timestampMs)`. World preparation then evaluates animation and entity placement before pose uploads. CPU-only simulations may also call `world.update(timestampMs)`; the persistent world pose revision prevents a repeated evaluation from discarding dirty uploads. Direct writes to model pose arrays/controller `update()` are lower-level APIs and should not bypass world revision tracking.

Changing transforms, parents or component data requires no GPU rebuild. Spawn/destroy changes membership: pause submissions, mutate the world, await `renderer.setWorld(world)`, then resume. Preparation is atomic and uses the same device validation queue as asset/environment loading. Failed candidates release their resources and retain the old attachment. Submitting uncommitted membership throws without permanently disabling the renderer; refresh with `setWorld()` to recover. Changes during preparation reject that candidate. Empty worlds render the background and keep the fixed binding layout valid. `setAsset()` switches back to the original viewer path.

Every prepared draw retains its model-local pose owner and its global transform index. Skin/morph output remains independently owned; bounds, winding, shadows and occlusion track the correct model even when local node indices are identical. The world combines authored lights with a maximum of 32; models without authored lights do not each add a fallback. A world with no authored lights uses one fallback light. Model assets attached for rendering currently require renderable mesh primitives; gameplay-only entities need no model.

All world model roots are movable, so their mesh records remain independently updateable. GPU allocation and pipeline preparation still occur on world attachment rather than per frame. The upload → compute → shadow → color → presentation order and stale-visibility safeguards remain unchanged.

## Verification

CPU world tests cover one load for repeated references, independent multi-node instances/playback, parent/root transforms and skin-joint revisions, authored-pose restoration, scene round trips, copied component/transform data, invalid documents before loading, and subtree removal. Architecture checks keep engine CPU modules independent of renderer/viewer modules.

The WebGPU world regression renders several entities using multiple models. It compares deformation with the CPU oracle through independent clips, parent movement, mirrored roots and offscreen movement; checks world-wide transform addressing and lights; checks upload/compute/shadow/color ordering; and exercises failed replacement, membership commits, resource release, empty worlds and switching back to the viewer asset path.
