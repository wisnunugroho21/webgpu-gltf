# Device recovery and measured scale

## Device-loss lifecycle

`Renderer.deviceState` reports ready, lost, recovering, disposed or failed. Device loss stops render submissions and invokes `RendererOptions.onDeviceLost`; ordinary GPU validation/frame errors continue through the error callback. Without a loss handler, the error callback reports loss and the need for explicit recovery. Device recovery is an application boundary, not a simulation system or renderer-owned loop.

```ts
const renderer = await Renderer.create(canvas, showFatalError, {
  onDeviceLost(message) {
    runtime.pause(); // Also stop submission and clear held input in your application.
    void renderer
      .recover()
      .then(() => {
        runtime.resume(); // Reapply your manual-pause/tab-visibility policy here.
      })
      .catch(showRecoveryError);
  },
});
```

Viewer and playable adapters make one automatic recovery attempt, holding their owner loops during reconstruction. A failed application attempt reports an error; a direct API owner can explicitly retry `recover()` while the facade remains lost. Concurrent recovery calls return the same promise. Disposing during an attempt cancels publication and releases its candidate device. Explicit `destroy()` does not request recovery.

Recovery retains CPU assets, world identity, entity/model poses, animation controllers, supported overrides, camera identity and output/environment/shadow/culling settings. User HDR pixels are copied and retained for reupload. All geometry, compressed textures, bind groups, pipelines, private deformation output and shadow/viewport attachments are rebuilt on a newly negotiated device. Existing Basis adaptation retranscodes original KTX2 blobs if the new compression capabilities differ. No GPU object is retained across devices. Reupload uses evaluated CPU poses without advancing animation, gameplay or physics; the normal upload → compute → shadows → color → presentation phases remain intact.

A `DeviceResources` owner represents each device generation and owns all render allocations, caches, attached scene leases and diagnostic wrappers. Creation, startup rollback and release share its lifecycle. Asynchronous scene preparation captures that owner; a disposed/lost owner rejects commitment even if recovery is preparing a different device. Recovery privately initializes/reuploads a replacement and swaps one owner reference. CPU worlds, evaluated poses, playback and camera state remain on the facade, including after a failed attempt, so retries do not restore defaults. Visibility query/readback owners are destroyed. Render handles must be reacquired after recovery; cached handle identity and private GPU output are invalidated. The facade rejects render calls and returns no handle while lost. This preserves stable handles only within one device attachment, including incremental membership changes.

Retain original CPU assets/KTX2 blobs and the world for recovery. Closing image data or changing world membership during preparation can invalidate an attempt; await a stable engine structural boundary, or retry after it. Recovery does not suppress deformation/shadow updates using old visibility. Uncaptured validation errors are fatal and are not silently retried as device loss.

## Diagnostics and budgets

Opt into `memoryProfiling`, `cpuProfiling`, `gpuProfiling` independently when creating the renderer. Read `renderer.diagnostics` for copied statistics and the latest asynchronous GPU timing sample. Profiling is disabled by default; the playable inspection example opts in.

Memory tracks startup plus later requested buffers and texture payloads, including compressed block tails, mip chains, array/volume layers, HDR and MSAA. Cumulative allocations, live/peak bytes and budget appear separately. Depth24plus is estimated at four bytes. Pipeline/bind group/query implementation storage, swapchain, alignment/padding inside the driver and browser allocations are excluded: this is not measured physical VRAM. Unknown formats fail measurement rather than undercount. Diagnostic wrappers are removed on disposal; renderer-owned tracked live bytes reach zero after release. Empty world attachment releases scene/model leases while neutral/startup resources remain until renderer destruction.

`resourceBudgetBytes` enables tracking and rejects a buffer/texture request before allocation if the requested live payload would exceed the limit. Count candidate/active overlap, environment filtering temporaries, lazy shadows, resized attachments and timestamp readback when choosing capacity. Scene candidate failure rolls back and leaves the prior attachment usable. Budget exhaustion during a frame resize/shadow allocation is a fatal frame error; the owner must choose adequate viewport/feature capacity. The budget does not evict live resources or guarantee a physical VRAM limit.

GPU profiling requests `timestamp-query` only if advertised. Unsupported devices render normally with no timings. Pass beginning/end timestamps resolve into one bounded asynchronous readback; samples are skipped while it is busy. No render call waits. The latest report contains pass labels and millisecond durations; their sum excludes gaps, copies outside passes and presentation scanout. At most 64 passes are timed in one sample; `truncated` reports when the sample omits further passes. CPU phase timings remain independent wall measurements. Never infer GPU execution from command encoding, submission or completion-wait latency. The implementation follows the [WebGPU timestamp/loss contracts](https://gpuweb.github.io/gpuweb/).

## Measured baseline and next scale work

`pnpm bench:migration` now writes schema 3: separate evaluation/render CPU costs, complete startup-inclusive memory and optional GPU pass totals, alongside the earlier after-startup allocation scope. The checked-in [Phase 7 report](baselines/phase7-2026-10-02.json) records Edge 154, Windows, Intel gen-12lp, 320×240, single sampling, shadows off, shared original fixtures, 25% animated instances, ten warmup and thirty measured frames.

| Entities | Live payload including startup | Render CPU median / p95 | Evaluation CPU median / p95 | GPU pass median / p95 |
| -------- | ------------------------------ | ----------------------- | --------------------------- | --------------------- |
| 16       | 1,247,172 bytes                | 0.20 / 0.30 ms          | 0.10 / 0.20 ms              | 0.233 / 0.245 ms      |
| 128      | 1,311,908 bytes                | 0.30 / 0.50 ms          | 0.10 / 0.30 ms              | 0.793 / 1.056 ms      |
| 512      | 1,533,860 bytes                | 0.90 / 1.10 ms          | 0.50 / 0.70 ms              | 1.589 / 1.802 ms      |

Only 15–16 GPU samples were available per row because readback skips busy frames. All three workloads released tracked bytes to zero. The first scene paid cold pipeline preparation (205 ms versus 22.5/36.1 ms); this ordering is not a scale trend. These synthetic fixtures have tiny geometry/textures and are not representative anime game content, sustained frame budgets or universal thresholds. Repeat with actual levels, resolution/MSAA, texture sets, authored lights/shadows and moving cameras before deciding bottlenecks.

Use existing CPU asset leases/eviction and transactional world attach/remove for explicit scene lifetime. Application streaming, automatic cache policy, LOD, clustered lighting, cascades and GPU visibility remain measurement-gated. Current measurements do not justify building those frameworks. Collect representative content first, then change one measured bottleneck and compare with the same workload/device.

Browser tests cover requested-resource budget rollback, scene unload, real compute readback after loss, fresh handles, preserved settings/playback, serialized recovery, failed retry and cancellation by disposal. Installed Edge is the default. `GPU_BROWSER_CHANNEL=chromium` or `chrome` selects another installed Chromium browser through Playwright; the installed browser must expose WebGPU. Firefox/Safari and different GPU vendors remain a separate validation matrix, not a claim derived from Chromium results.

The [playable baseline](baselines/playable-phase7-2026-10-02.json), captured by `pnpm bench:playable` on the same Edge/Intel device, adds the actual example's Rapier simulation, two shared toon actors, aiming, root-motion movement, a follow camera, shadows and 4x MSAA. At 640x360 it requested 15,326,604 live bytes with GPU pass median/p95 0.726/1.929 ms; at 1280x720 it requested 54,033,804 bytes with GPU 2.059/2.959 ms. Shadows alone requested 2,097,412 bytes in each workload. Both released tracked bytes to zero. Resolution/MSAA attachments dominate the increase, illustrating why resource budgets must include the intended viewport rather than only model geometry. These two runs still use original tiny generated content, not production anime art.

An alternate Chromium-channel run was attempted on this host; its cached executable failed to launch (`spawn UNKNOWN`) before any test ran. Only installed Edge/Intel validation is confirmed here. Firefox/Safari, another Chromium binary and other GPU vendors remain external acceptance work.

## Lifecycle refactoring verification

The first refactoring step moves device-owned state and scene transactions to `renderer/core/device-resources.ts`. Current checks pass: 185 CPU tests, browser TypeScript checking, production build, formatting, the full 81-case offline GPU run and all six lifecycle cases after adding three further regressions (84 distinct offline cases), four remote Khronos model cases and production Draco/Basis/game startup. These runs use local Edge/Intel; they do not expand the browser/GPU validation matrix or claim performance changes.

`browser-tests/device-lifecycle.spec.ts` covers failed world and single-asset recovery before retry, coherent owner replacement, preserved controller/camera/pose identity, suppression of old-device errors, missing/throwing canvas contexts, late startup rollback, restored diagnostics and cleanup that continues after a subsystem exception. Existing resilience tests cover cancellation by disposal, actual compute-output readback, fresh handles, settings and zero requested live bytes. Architecture tests prevent the facade from acquiring/destroying a device or configuring the canvas context directly.
