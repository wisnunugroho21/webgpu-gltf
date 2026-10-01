# Shadow allocation measurements — October 2, 2026

The previous implementation reserved 24 shadow maps, one reusable depth attachment, and 24 matrix records when constructing a renderer, even with shadows disabled. The new implementation starts with a 4-byte neutral storage binding and allocates exact active map capacity during frame preparation. No additional shadow rendering features were added.

## Measured requested allocations

Measurements used the installed Microsoft Edge with the local WebGPU adapter. The pre-change browser test read actual buffer sizes and depth texture dimensions from a `PunctualLighting` instance at each supported resolution. The post-change integration test tracks shadow GPU resource creation/destruction and checks that `renderer.shadowMemory` agrees with live allocation sizes.

These numbers describe requested resource storage, not physical VRAM residency or driver allocator overhead. They exclude the unchanged 4,112-byte light-record buffer, CPU arrays, pipelines and bind-group objects. Drivers may delay reclaiming destroyed resources until submitted work completes.

| Resolution | Before: sample buffer | Before: depth attachment | Before: matrix buffer | Before: total | After: idle/disabled total |
| ---------- | --------------------: | -----------------------: | --------------------: | ------------: | -------------------------: |
| 256²       |           6,291,456 B |                262,144 B |               6,144 B |   6,559,744 B |                        4 B |
| 512²       |          25,165,824 B |              1,048,576 B |               6,144 B |  26,220,544 B |                        4 B |
| 1024²      |         100,663,296 B |              4,194,304 B |               6,144 B | 104,863,744 B |                        4 B |

At the default 512² resolution:

| Active workload                                                          | Maps | Sample buffer | Depth attachment | Matrix buffer | Neutral buffer |        Total |
| ------------------------------------------------------------------------ | ---: | ------------: | ---------------: | ------------: | -------------: | -----------: |
| Startup, disabled shadows, zero-intensity lights, or no eligible casters |    0 |           0 B |              0 B |           0 B |            4 B |          4 B |
| One directional/spot light                                               |    1 |   1,048,576 B |      1,048,576 B |         256 B |            4 B |  2,097,412 B |
| One point light                                                          |    6 |   6,291,456 B |      1,048,576 B |       1,536 B |            4 B |  7,341,572 B |
| One point + directional + spot                                           |    8 |   8,388,608 B |      1,048,576 B |       2,048 B |            4 B |  9,439,236 B |
| Four point lights                                                        |   24 |  25,165,824 B |      1,048,576 B |       6,144 B |            4 B | 26,220,548 B |

One directional light uses about 92% less requested shadow storage than the old reservation. Maximum demand remains effectively unchanged, with four extra bytes for the persistent neutral buffer. Exact sizing favors lower retained memory over avoiding reallocations when different models repeatedly change map count; ordinary animation with unchanged light types/counts does not resize.

## Resource and phase contract

- Frame binding 4 remains read-only storage with a four-byte minimum; all pipelines use the same explicit layouts.
- Every unshadowed light has shadow index -1, so its shader returns full visibility before reading the neutral depth array.
- Capacity counts faces of the first four positive-intensity lights only when the scene has opaque/MASK triangle casters. The existing fallback directional light still casts shadows in scenes without authored lights.
- Grow/shrink/release occurs in the upload phase. Matrix uploads complete before compute, shadow and scene command encoding.
- A sample-buffer identity change refreshes both opaque and cached transmission frame groups. Viewport changes and pipeline recompilation are unnecessary.
- Disable/re-enable and scene changes take effect on the next frame. Allocation statistics are snapshots after preparation; setters alone do not run GPU work.

## Reproduce

```sh
npm run build
npm test
npx playwright test browser-tests/shadow-memory.spec.ts browser-tests/lights.spec.ts browser-tests/material-extensions.spec.ts
```

The memory regression tests log exact resource sizes. They cover all supported resolutions at startup and 512² transitions through empty, one-map, six-map, mixed, maximum, shrink, disabled, re-enabled, zero-intensity and caster-free scenes. They check stable allocations on unchanged frames, retained layout identity, GPU validation after every transition, transmission with an unchanged viewport, and release at disposal. Existing shadow tests verify directional/spot/point darkening, alpha masks, off-camera casters, computed deformation and revision-based reuse.

For embedding applications:

```ts
const renderer = await Renderer.create(canvas, showError, { shadowResolution: 512 });
await renderer.setAsset(asset);
// Read after the renderer has prepared a frame; setAsset itself does not allocate maps.
console.log(renderer.shadowMemory);
```
