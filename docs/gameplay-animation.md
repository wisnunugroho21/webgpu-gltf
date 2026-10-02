# Phase 6 gameplay animation

The controller supports node masks, additive overlays, authored events and translation root motion. The playable slice exercises them with E to aim, visible footfall counts, and **Use authored root motion**. Model data and prepared clips remain shared; clocks, queues, overlays and pose output belong to each instance.

## Clocks and events

Viewer playback defaults to `presentation`. Gameplay calls `setClock('external')`, then `advance(step.deltaSeconds)` once per fixed gameplay step. `World.update(timestamp)` can still prepare presentation; it evaluates pending changes without advancing this external clock. Do not additionally advance the same controller through a second scheduler. Pause and tab suspension stop fixed steps, excluding suspended wall time.

Author events through `gltf.animations[i].extras.engine.events`, for example:

```ts
extras: {
  engine: {
    events: [
      { time: 0.25, name: 'foot-left' },
      { time: 0.75, name: 'foot-right' },
    ];
  }
}
```

Times are seconds within the prepared clip duration. Preparation validates and copies this metadata. `drainEvents()` transfers the instance's pending events and empties the queue. Each event includes clip index, authored name/key time, effective fade weight at the crossing, and controller elapsed seconds. Consume queues regularly; the application discards unused companion events.

Intervals are `(previous,current]`, including every crossed loop. Time-zero events fire at loop boundaries, not attachment. Duration events and time-zero events are distinct authored markers. Zero-weight layers emit nothing. Active outgoing clips emit until their fade completes; interrupted outgoing poses are frozen snapshots and emit no further events. Returned events sort by elapsed time and clip index. Seeking/selecting/manual layer replacement clear pending events and rebase without synthesizing crossings. Paused/held updates emit nothing. Masks select pose nodes, not event names; decide gameplay relevance from event name, clip and weight. Additive clips can carry their own events.

## Masks and additive layers

`AnimationLayer.mask` contains explicit node indices; descendants are not implicit. Omitted masks include all nodes, and an empty mask affects none. Absolute weights normalize **per node**; totals below one retain authored defaults. Metadata and masks are copied on entry and when reading state. `speed` defaults to one; zero holds an overlay pose. Negative/reverse speeds are unsupported.

```ts
model.animation.setOverlays([
  {
    clip: aimClip,
    time: 0.5,
    speed: 0,
    weight: 1,
    additive: true,
    referenceTime: 0,
    mask: [leftArm, rightArm],
  },
]);
```

Overlays have independent clocks and remain outside base locomotion transitions. Additive translation/morph values are differences from the reference sample; scale uses ratios and rejects undefined zero-reference ratios. Rotation uses the shortest-path weighted relative quaternion, applied after absolute layers. Additive weights are limited to `[0,1]`. All missing channels retain authored values; reference keys/defaults are never mutated. `setOverlays([])` releases the layer.

Fade interruption captures the base animation without overlays, then applies overlays once. Explicit model node overrides remain outside both the mixer and snapshots, preserving their ownership until cleared. Existing sparse target/revision evaluation continues to restore retired masked targets and leave unaffected nodes unchanged. Retargeting and IK remain separate features; applications can use supported node overrides for explicit exceptions.

A crossfade from a masked/additive multilayer base also captures a frozen base snapshot, preserving its per-node normalization at transition start. Use the separate overlay API for moving upper-body layers that should continue advancing across locomotion transitions. Event intervals exceeding 4096 crossings per layer reject with an explicit error; advance smaller intervals for unusually dense offline event playback instead of silently dropping markers.

## Root-motion ownership

```ts
model.animation.setClock('external');
model.animation.setRootMotion({ node: modelRoot, mode: 'extract' });
// Fixed gameplay, before collision integration:
model.animation.advance(step.deltaSeconds);
const localTravel = model.animation.consumeRootMotion();
// Convert model-local travel to the application's world-facing velocity,
// then pass that velocity to PhysicsAdapter. Physics publishes the entity root.
```

The root must be a root TRS node. Both `in-place` and `extract` suppress its animated translation, using authored translation before explicit overrides. `in-place` queues no travel; `extract` queues model-local translation deltas including complete cycle displacement. `consumeRootMotion()` returns a detached vector and clears it, so second consumption returns zero. Seek/mode changes/manual layer replacement clear pending travel. Disable with `setRootMotion()` to restore ordinary model-local root playback. Translation overrides remain explicit higher-priority exceptions.

Absolute layers with the root in their mask contribute travel, normalized among root-participating layers. Additive layers do not drive root motion. Fades blend displacement with interval-average weights; frozen interruption snapshots contribute no travel. This is velocity blending, not displacement generated by pose differences during a transition. Nonlinear travel curves use sampled endpoint deltas with average fade weights, so use fixed steps for consistent gameplay integration.

The game clips contain authored forward travel at walk/run speeds. Its optional extracted path maps travel magnitude onto the current input heading and feeds the same collision controller. It never writes an entity root from animation; physics remains the only root writer. The default path uses input speed with in-place clips. Vertical jumps stay under physics. Rotation extraction, arbitrary model-axis conversion, root-motion warping/retargeting and physics teleport APIs are not implemented.

CPU tests cover masks, additive snapshots/overrides, immutable clips, multi-loop/fading event delivery, pause/seek, one-time consumption and identical real-physics results at 30/144 render Hz. GPU fixtures verify toon/outline rendering over independently deformed skinned/morphed output. See [anime presentation](anime-presentation.md).
