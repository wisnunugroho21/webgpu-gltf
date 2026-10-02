# Phase 0 migration safeguards

The migration starts with behavior, dependency and measurement checks. These changes do not move simulation or change renderer scheduling; that is Phase 1.

## Run the checks

Use Node 24 and pnpm 11.20.0 with the checked-in lockfile:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm check:browser
pnpm test
pnpm build
pnpm test:browser:offline
pnpm test:compressed-build
pnpm test:browser:remote
pnpm bench:migration
pnpm bench:playable
```

Production decoder checks require the preceding build. Browser and decoder checks use installed Microsoft Edge with a usable WebGPU adapter. They fail if the adapter is unavailable. Run GPU suites sequentially to avoid unrelated load and shared development-server interference.

`tsconfig.browser.json` inherits strict and unused-symbol checks, includes browser fixtures, benchmarks and Playwright configs, and resolves Vite's absolute module URLs to the actual source types. Node types cover the test runner, while DOM and WebGPU types cover page callbacks. Existing generated-fixture accesses assert arrays that those fixtures provide; real decoded assets still pass through production validation. No compiler checks were disabled.

Offline commands exclude tests tagged `@remote` even if `TEST_REMOTE_MODELS` is inherited from the shell. Remote commands explicitly enable that flag and select only tagged tests: DamagedHelmet, ChronographWatch, SimpleSkin and AnimatedMorphCube. The original `test:browser` command remains compatible with the flag and skips these four by default.

## Test inspection boundary

`browser-tests/helpers/inspect.ts` is a test-only inspection boundary. It copies and freezes scene statistics, world matrices, revisions, draw groups and visible runs. GPU resources become stable opaque identity tokens so inspection cannot destroy a buffer or mutate GPU resources. Snapshots stay unchanged when later poses advance. The inspection regression and animated-instancing regression use this surface.

`testDevice()` deliberately grants GPU access for instrumentation and readback, separately from read-only inspection. Existing specialized tests that inject failures or delayed visibility still use their narrow private instrumentation; migrating those fault-injection hooks is separate work. Production exports do not expose these helpers. Architecture tests prevent production imports of tests/benchmarks and continue guarding CPU/GPU/viewer boundaries, renderer scheduling and circular dependencies.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests: frozen dependency installation, formatting, strict browser checking, CPU tests and production build. It needs no GPU.

`.github/workflows/gpu.yml` is manually dispatched against a reviewed revision on a trusted runner labelled `self-hosted`, `Windows`, `X64`, `webgpu`. Provision installed Microsoft Edge, compatible GPU drivers and a usable adapter in the runner's headless session. The workflow installs Node/pnpm and project dependencies; it runs offline GPU tests, builds and loads production Draco/Basis decoders, captures baselines and uploads test artifacts. Its checkbox enables the separate remote suite. It does not execute untrusted PR code automatically on a self-hosted machine. Registering the runner and dispatching CI are repository administration steps; checked-in workflows alone do not prove hosted execution.

## Baseline procedure and interpretation

`pnpm bench:migration` writes `test-results/migration-baseline.json` and attaches it to the Playwright result. Preserve a report before another Playwright run clears that output directory. Compare measurements on the same device/browser revision and settings, with other GPU workloads closed; run several times before treating small timing differences as meaningful.

The deterministic workloads contain 16, 128 and 512 entities. Every fourth entity uses the generated skin/morph/animation fixture; others use the instancing demo. They share two loaded models. One entity root moves each frame and clips play independently. A blank same-origin harness avoids the viewer's unrelated RAF loop and GPU resources. Settings are 320×240 CSS pixels, single-sample color, shadows off, ten warm-up frames and thirty measured frames at 60 Hz timestamps; the report includes device pixel ratio. Scene/frustum statistics record the work actually submitted. These are bounded synthetic migration workloads, not representative game content or universal size categories.

Each report identifies browser, device information available from WebGPU, negotiated device features, settings and capture time. Construction and asynchronous scene preparation are separate wall-time measurements. Preparation includes pipeline creation and may be affected by driver caches: workloads run small → medium → large, so the first preparation can pay cold compilation costs. The historical Phase 0 report combines pose and rendering costs. Schema version 2 introduced engine `evaluationCpu` (evaluation/mixing/world time and node counts) separately from render-only `cpu` (uploads, visibility, encoding, submission and total); legacy renderer pose fields remain zero. Mixing/world values are nested within evaluation; they must not be summed as independent phases. Sampled/visited node values are counts rather than milliseconds. GPU-completion waits occur outside CPU measurements.

The allocation helper tracks buffers/textures created **after Renderer.create()**, including scene resources and subsequently allocated viewport attachments. It reports cumulative allocation counts/bytes, live and peak requested bytes and live bytes after renderer destruction. Buffer bytes use requested GPU sizes; texture payload estimates include all mips, layers and samples. Depth24plus uses a four-byte estimate. Renderer startup resources, swapchain images, driver padding, query storage and hidden browser allocations are excluded. Unknown texture formats fail rather than silently undercount. These numbers describe requested payload, not actual physical VRAM. The baseline requires all tracked live bytes to reach zero after destruction.

Historical reports keep `gpuExecutionMs` null. Current schema 3 additionally reports startup-inclusive `completeMemory` and capability-negotiated asynchronous `gpuExecution` pass totals, separately from CPU wall time; see the [Phase 7 baseline](resilience-and-scale.md). It drops GPU samples while readback is busy. CPU encoding/submission time is not GPU execution time. For capability-detected timestamp measurements of occlusion query passes, use the existing `pnpm bench:occlusion` and [occlusion benchmark guide](occlusion-benchmark.md). It requests `timestamp-query` only when supported and reports GPU query time separately; it does not measure whole-frame GPU time.

The checked-in [initial measurement](baselines/migration-2026-10-02.json) is a comparison reference, not a performance threshold. Do not gate migration on fixed timing limits across different hardware. Behavior, ownership and dependency assertions remain the regression gates.
