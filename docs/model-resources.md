# Loaded model resources and instances

Load an `Asset` once into `ModelLibrary` and reference that asset from multiple entities. A `ModelInstance` owns its pose and animation controller; it does not own GPU geometry or materials. glTF and engine scene JSON stay unchanged.

The renderer's `SceneBuilder` acquires a separate `ModelResources` record for each original `Asset` object. The cache belongs to one renderer, so records never cross devices or incompatible binding layouts, antialiasing configurations or transparency modes. Two separately loaded copies of a file are different assets; there is no URL/content deduplication. To change immutable geometry or material definitions, load/register a new asset object rather than mutating one already in use.

| Shared loaded resources                                                       | Independent instance/scene state                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| Prepared primitive geometry, buffer views, repacked attributes, index buffers | Pose arrays, animation clocks and entity transforms       |
| Material uniforms/bind groups, textures, mip chains and samplers              | Draw records, bounds, visibility and transform bindings   |
| Render and shadow pipeline caches                                             | Joint palettes, morph weights and deformed vertex outputs |
| Decoded/packed base vertices, morph deltas and skin influences                | Deformation batch arenas and dirty revisions              |

Compression negotiation happens once when the record is created. Geometry decoding and uploads are cached lazily by primitive/view identity. Texture caching retains slot-specific sRGB/linear interpretation, mip filtering semantics and neutral defaults. Independent deformation outputs bind the same immutable inputs while consuming their own palette and weight ranges. Batching remains per model instance; this change does not introduce cross-entity deformation batches.

## Lifetime and replacement

Each preparation acquires a lease attached to its scene `Resources`. The model's allocations use a different `Resources` owner. Active and candidate scenes can therefore overlap safely:

1. Preparing another instance of the same asset reuses its record.
2. Failed candidates destroy their private outputs and release their leases; the active scene still retains shared assets.
3. Successful replacement releases the previous scene after the candidate commits. Shared inputs are retained when the new scene still uses the asset.
4. Releasing the final lease destroys shared buffers/textures exactly once and removes the record. A later attachment prepares a fresh record.

There is no permanent unused-asset GPU cache. Removing an entity from `World` requires the existing explicit `await renderer.setWorld(world)` commit before the attached scene releases it. CPU assets remain in `ModelLibrary` for future instantiation. Renderer disposal releases the active scene and its leases; pending failed preparation also releases allocations created asynchronously after disposal.

Opaque grouping merges draw lists when shared pipeline/material objects recur across entities. Global transform indices and model-local pose ownership remain distinct. The pose-upload → compute → shadow → render phases are unchanged; visibility never suppresses required deformation/shadow updates.

## Verification

`tests/resources.test.ts` covers shared loads, overlapping scene ownership, final eviction, idempotent release, failed loading and disposal during asynchronous creation. `browser-tests/world.spec.ts` verifies shared buffer/material/pipeline identities across independently animated entities, independent GPU outputs against the CPU oracle, complete opaque groups, retained inputs across spawn/destruction commits, and final release on an empty-world replacement. Existing viewer, animation, compression and material tests cover the single-asset path.
