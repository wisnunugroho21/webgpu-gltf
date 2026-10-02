# Phase 1: engine-owned updates and cameras

`EngineRuntime` is CPU-only. It coordinates input → bounded fixed gameplay/physics ticks → presentation overrides → one visual animation/root evaluation → application presentation. It does not schedule frames, create a canvas, own a renderer or implement a physics solver. Hooks are deliberately small until later phases introduce systems and a physics backend.

```ts
import { EngineRuntime, FollowCamera, Renderer, World } from './src';

const renderer = await Renderer.create(canvas, showError);
const world = new World(models); // ModelLibrary prepared by your asset-loading code.
const player = world.createEntity({ id: 'player', model: { asset: 'hero' } });
world.update(0); // Establish model roots before preparing rendering membership.
await renderer.setWorld(world);

const camera = new FollowCamera();
let lastPresentationMs = 0;
const runtime = new EngineRuntime(world, {
  captureInput: () => input.capture(),
  gameplay: (step) => gameplay.update(step.deltaSeconds),
  physics: (step) => physics.step(step.deltaSeconds),
  preparePresentation: (frame) => physics.writePresentationTransforms(frame.alpha),
  present: (frame) => {
    const root = player.worldMatrix;
    camera.update(
      [root[12], root[13], root[14]],
      (frame.presentationTimeMs - lastPresentationMs) / 1000,
    );
    lastPresentationMs = frame.presentationTimeMs;
    renderer.render(frame.presentationTimeMs, camera.view(renderer.aspectRatio));
  },
});

// Supply these callbacks from your own scheduler; no engine or renderer RAF exists.
function frame(wallTimestampMs: number) {
  runtime.advance(wallTimestampMs);
}
```

`input`, `gameplay`, and `physics` above illustrate application services, not bundled implementations. A physics service must write entity roots using their explicit physics ownership. The presentation hook receives an interpolation fraction; it may publish interpolated roots from its own previous/current simulation states. The runtime does not invent transform history. Animation events and extracted root motion, when implemented, should use the fixed simulation clock, not presentation callbacks.

## Clock and lifecycle

The first `advance(wallTimestampMs)` anchors the wall clock and evaluates visual state at presentation time zero, without a simulation tick. Defaults are a 60 Hz fixed step, at most five ticks per advance, and at most 250 ms of accepted wall time. Elapsed time beyond that clamp, and whole steps beyond the tick budget, are dropped and reported as `frame.droppedMs`. A fractional remainder is retained. `simulationTimeMs` advances only through completed fixed ticks; `presentationTimeMs` adds the fractional remainder. Thus a suspended browser cannot fast-forward physics or clips by several seconds on recovery.

Wall timestamps must be finite and monotonic while running. Fixed hooks receive `deltaSeconds` and simulation time. Each advance captures input once and evaluates visual animation/root transforms once, after all fixed writes. With no `present` hook the world simulates without a canvas. Rendering may be skipped or repeated independently; `render()` does not consume animation time.

`pause()` and `resume()` are idempotent. Pause freezes both fixed and visual clocks, retaining the interpolation remainder. Calling advance while paused can still apply explicit overrides and publish a frame. Resume re-anchors on the next wall timestamp, excluding paused wall time. The application may connect these methods to visibility/lifecycle events. `destroy()` rejects future advances; it does not destroy the world, GPU resources or the caller's scheduler. Stop that scheduler before destroying its owned renderer. Hook errors propagate to the caller, which owns failure/stop policy.

## Render contract

`Renderer.render(timestampMs, view?)` retains its old finite timestamp argument for compatibility, but does not advance the world or animation. For single assets call `renderer.animation.update(timestampMs)` explicitly before rendering. For engine scenes use `EngineRuntime.advance()` or `world.update(presentationTimeMs)`. Also evaluate entity roots before `setWorld()` so preparation and automatic viewer framing use current placement. After spawn/destruction, evaluate the world and await `setWorld()` before submitting the new membership.

Each renderer compares its last uploaded revision with every attached model pose's current revision. These revisions survive unchanged re-evaluation, skipped frames and explicit overrides made without a new aggregate World revision. Uploads update transforms, deformation inputs, bounds and winding before visibility/shadow preparation. The pass order remains upload → compute → shadows → color → presentation. Stale visibility never suppresses deformation or shadow updates.

`World.profiling = true` enables copied `world.cpuTimings` for CPU pose evaluation, with nested mixing/world values, hierarchy evaluation (`hierarchyMs`) and sampled/visited node counts. See [hierarchy diagnostics](world-hierarchy.md) for changed-branch counters and atomic structural edits. Renderer profiling covers only its upload/visibility/encoding/submission work. Its retained legacy animation/mixing/world/count fields are zero; they are not a proxy for engine work. Migration benchmark schema version 2 records `evaluationCpu` separately from renderer `cpu`; the Phase 0 report remains a historical reference. GPU completion waits stay outside both CPU measurements.

The [Phase 1 baseline](baselines/migration-phase1-2026-10-02.json) records all three workloads using the separated measurements and confirms zero tracked live bytes after destruction. Compare it with the [measurement scope](migration-safeguards.md); CPU rendering totals and evaluation totals now have distinct meanings, and preparation still includes cold pipeline/cache effects.

## Camera contract and viewer compatibility

`CameraView` carries view/projection matrices, a world-space eye and the aspect ratio used to prepare projection. Use WebGPU's zero-to-one projection depth range. Data is borrowed for the render call; the renderer uploads a view-projection matrix and uses the supplied view direction/eye for transparent sorting and lighting. It validates finite dimensions and rejects a mismatched aspect before GPU work, without disabling the renderer. `renderer.aspectRatio` computes the current physical target ratio without allocating attachments; rebuild the view when the viewport changes.

`FollowCamera` and `OrbitCamera` are CPU classes usable headlessly. Follow behavior uses an exponential damping factor with a caller-supplied presentation delta. The renderer retains a default CPU orbit state for its compatibility facade and automatic asset framing; an explicit camera view takes precedence. It does not attach pointer/wheel/key listeners.

The viewer owns `OrbitInput` and removes its DOM listeners during teardown. `renderViewerFrame()` evaluates the current single asset or attached world, then renders it. `ViewerRenderLoop` still owns only RAF lifecycle; `Viewer` composes these adapters and routes evaluation failures through its application error path. Seek, pause, clip blending, orbit/reset and resize retain their previous viewer behavior. Engines need no viewer imports.

## Regression coverage

`tests/runtime.test.ts` checks headless order, fixed-step bounds, dropped time, pause/resume, held/skipped pose revisions, profiling isolation, clock validation and CPU camera depth/aspect behavior. Architecture tests prevent rendering from evaluating animation/world state or attaching input listeners. `browser-tests/engine-presentation.spec.ts` verifies externally evaluated skin/morph poses, repeated renders at different timestamps, skipped frames, direct joint overrides, engine follow views, aspect rejection and resize on a real GPU. Existing viewer, phase-order, transform, shadow, deformation and visibility regressions use the external viewer policy where animation evaluation is needed.
