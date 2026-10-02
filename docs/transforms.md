# Supported gameplay transforms

## Ownership

| Transform            | Default writer                     | Explicit exception                             |
| -------------------- | ---------------------------------- | ---------------------------------------------- |
| Entity local root    | Gameplay, or physics after handoff | `setTransformOwner()` transfers root authority |
| Model node locals    | Animation and authored defaults    | Per-field `setNodeOverride()`                  |
| Model world matrices | World/pose hierarchy evaluation    | Derived values, read through copies            |

Entities default to `transformOwner: 'gameplay'`. Use `entity.setTransformOwner('physics')` to hand placement to a physics system; then that system writes `entity.setTransform(patch, 'physics')`. Ordinary `setTransform(patch)` identifies a gameplay writer and rejects writes while physics owns the root. Handoff preserves the current transform. Hand back explicitly with `setTransformOwner('gameplay')`. Applications decide when to transfer ownership; there is no automatic rigid-body integration. Parent composition still applies, so root patches are entity-local TRS, not world-space physics poses.

```ts
player.setTransformOwner('physics');
// After physics simulation, before world evaluation/rendering:
player.setTransform({ translation: bodyLocalPosition, rotation: bodyLocalRotation }, 'physics');
// Deliberate exception within this animated model:
player.model!.setNodeOverride(handNode, { rotation: handRotation });
player.model!.clearNodeOverride(handNode, ['rotation']);
```

Animation never writes entity roots, regardless of clip selection, crossfades or authored-pose reset. Animated glTF root-node motion remains internal to the model; it is not automatically extracted into physics/entity movement. Pose evaluation composes entity placement with animated model locals.

`getNodeOverride(node)` returns copied active override fields; an empty object means animation owns all three TRS fields. `setNodeOverride(node, patch)` explicitly claims only the supplied fields. `clearNodeOverride(node, fields?)` returns selected fields to animation, or clears every field when omitted. Rotation can therefore return to animation while a scale override persists. Clearing resumes the latest sampled animation, including paused poses and fades. `setNodeTransform`/`clearNodeTransform` retain their existing override behavior for compatibility. Single-asset rendering provides the same explicit override methods with its existing `movableNodes` requirement.

Scene JSON optionally stores `transformOwner: 'gameplay' | 'physics'`; omitted values mean gameplay. Physics ownership round trips with root placement. Model overrides remain per-instance runtime state, separate from shared assets/clips and scene root ownership.

## Placement and node edits

Move a whole gameplay object with `entity.setTransform(patch)`. Its placement lives outside the model's glTF node hierarchy and animation defaults. Entity parents propagate movement to child entities; mirrored entity scales also select the skinned model's winding variant. Gameplay may call `world.update(timestampMs)` before rendering; repeating that timestamp never loses a pending pose change.

```ts
const player = world.getEntity('player');
player.setTransform({ translation: [x, y, z] });
player.model!.setNodeTransform(handNode, { rotation: handRotation });
world.update(timestampMs);
renderer.render(timestampMs);
```

`ModelInstance.getNodeTransform(node)` returns a copy of effective local translation, rotation and scale. `setNodeTransform(node, patch)` sets persistent **absolute local** overrides for the supplied fields, after animation mixing. Other fields continue following animation. Repeated partial calls preserve earlier overrides on that node. `clearNodeTransform(node)` removes all its overrides and resumes the current animation/authored values immediately. These methods return whether effective pose worlds changed; a valid override can be recorded even when it currently matches the animation and returns `false`.

Use model-local glTF node indices, not entity IDs. Per-instance overrides do not change loaded assets or shared animation clips. Scene JSON saves entity placement; node overrides are runtime pose state and are not serialized. Animation interruption snapshots exclude gameplay overrides, so clearing an override cannot accidentally leave it inside an interrupted fade.

## Single-asset renderer

Declare gameplay-movable nodes when preparing a single asset:

```ts
await renderer.setAsset(asset, { movableNodes: [doorParentNode] });
renderer.setNodeTransform(doorParentNode, { rotation: doorRotation });
renderer.render(timestampMs);
renderer.clearNodeTransform(doorParentNode);
```

`movableNodes` reserves independently mutable draws for those nodes and every descendant. A movable parent without a mesh therefore still updates its children's meshes. Unrelated static primitives retain their original winding/instance grouping. The renderer's `getNodeTransform`, `setNodeTransform` and `clearNodeTransform` reject undeclared nodes instead of silently editing a statically packed transform. Declare additional nodes through another awaited `setAsset()` preparation; existing one-argument calls remain unchanged.

For worlds, all model mesh records are already reserved for entity movement. Use `entity.model` setters; renderer-level node setters reject world mode because a node index alone does not identify a model instance. Transform edits require no scene rebuild. Spawning/destroying entities still requires the explicit world membership commit.

## Validation and revisions

Setters copy input arrays and validate finite float32-range TRS values, vector lengths, nonzero scale and a nonzero quaternion. Quaternions normalize; negative scales support reflections. Invalid edits are rejected before changing override state. Empty patches and unchanged effective worlds produce no revision/upload churn. Getter results are copies.

Node TRS overrides currently reject authored matrix nodes; move their entity, or author TRS nodes in the source model. Entity placement applies to both matrix and TRS nodes. No world-space node setter, physics integration or node reparenting is included. Avoid writing directly to `pose.nodes`, world matrices, glTF node fields or clip keys: those bypass validation, override policy and the prepared mutability classification.

`Pose.revision` advances when effective world matrices or morph weights change. Each node's existing `worldRevision`/`weightsRevision` still identify the actual dependency. Worlds remember model revisions independently of the animation controller's return value. Single-asset rendering compares its last uploaded pose revision after animation evaluation. This captures gameplay edits made outside the frame loop without forcing unrelated node uploads.

The frame retains pose upload → compute → shadow → color rendering. Dirty rigid records update world/normal uploads, winding pipelines and bounds. Joint edits update affected palettes, compute outputs and deformation bounds. Shadow dependencies and occlusion invalidation consume the same model-owned revisions before visibility selection; stale visibility cannot suppress deformation or shadow updates. World-space skinning intentionally ignores mesh-node translation when that node does not move an influencing joint; move the entity or the skeleton to place a skinned model.

`tests/transform-api.test.ts` verifies copied/validated edits, descendants, no-op revisions, animation precedence/clearing and repeated world evaluation. The GPU regressions verify static-group preservation, transform uploads, reflected winding, updated culling bounds, shadow refresh, stale occlusion invalidation and independently deformed joints against the CPU oracle.
