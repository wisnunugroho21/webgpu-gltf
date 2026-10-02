# CPU asset validation and limits

Refactoring part 3 gives glTF URL/file loads one CPU policy before they return an `Asset`. The policy is independent of device allocation budgets. It bounds transport, JSON metadata, accessor expansion, animation work, compressed geometry and image dimensions; it does not measure exact process memory.

## Boundary and ownership

`gltf/loader.ts` orchestrates the load. `gltf/transport.ts` reads dependencies sequentially into one per-load `AssetBudget`; `gltf/limits.ts` defines policy and contextual errors. `gltf/validation.ts` checks table shapes and byte declarations, then delegates accessor, scene, material and animation metadata to focused modules in `gltf/validation/`. The payload validator scans components without materializing extra accessor arrays, checks finite values, sparse ordering, primitive indices and skin palettes/weights, and reuses animation preparation to validate packed keys and events before publication.

Repeated primitive/morph accessor references and omitted per-node morph weights also count against expansion limits; small metadata cannot request unbounded downstream CPU arrays. Metadata checks precede dependency reads and decoder output allocation. JSON itself necessarily has to be parsed first, so JSON bytes have a separate bound. Local file sizes are checked before `arrayBuffer()`. HTTP response bodies are read in chunks: `Content-Length` permits early rejection but actual received bytes remain authoritative. Each retained chunk consumes the shared transport budget; rejected streams are canceled. Dependencies are sequential to avoid continuing sibling downloads after a validation failure. A platform response without a readable body falls back to a size check after `arrayBuffer()`.

Meshopt reserves output bytes before creating its destination. Draco validates accessor declarations before starting the worker, reserves attribute bytes, and gives the worker an index-count ceiling from the remaining decoded-byte budget. The worker checks actual mesh counts before output copies/WASM allocations; returned indices consume the budget before retention. Triangle strips account for conversion to triangle lists. Decoder-created accessor/view counts are also bounded.

`gltf/images.ts` reads PNG IHDR, JPEG frame and KTX2 header/level metadata before native bitmap decode or Basis transcode. Base dimensions and aggregate base pixels bound an RGBA-sized estimate even when a device retains compressed blocks. Basis checks dimensions, mip shape and exact output size before allocating each output level. Authored mipmaps and color/data slot interpretation remain unchanged; sRGB decoding still follows material slot usage.

The resolved frozen policy travels with loaded assets. Later `decodeAccessor()` calls validate ranges and sparse indices before allocating result arrays and enforce the same per-accessor ceiling. Procedural assets without a policy use the default accessor ceiling. Device recovery/retranscoding uses the retained policy as well.

## Configuration

```ts
import { loadUrl, AssetRegistry, defaultAssetLimits } from './src';

const limits = {
  maxResourceBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxNodes: 20_000,
  maxImageDimension: 8192,
};
const asset = await loadUrl('character.glb', { limits, signal });
// loadFiles(files, { limits, signal }) accepts the same policy.
const registry = new AssetRegistry({ limits });
console.log(defaultAssetLimits.maxAccessorValues);
```

Overrides must be positive safe integers. Configure a registry once so same-URI requests retain their shared transport/decode contract. A custom resolver or direct `register()` supplies already loaded/trusted assets and is responsible for its own decoding validation. Registry cancellation, leases, retry and transactional `loadWorld()` contracts are preserved. Aborting a load terminates its decoder worker and rejects outstanding work; an aborted/failed asset is never inserted into the ready cache. An existing world is not changed by a failed replacement load.

| Limit                    | Default     | Counts                                                                                                      |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `maxResourceBytes`       | 256 MiB     | One model or dependency's received/local bytes                                                              |
| `maxTotalBytes`          | 512 MiB     | Model plus dependency transport bytes, including data URIs                                                  |
| `maxJsonBytes`           | 16 MiB      | Plain glTF JSON or GLB JSON chunk                                                                           |
| `maxDecodedBufferBytes`  | 512 MiB     | Retained source buffers plus decoded geometry buffers; declared buffers checked early                       |
| `maxAccessorValues`      | 16,777,216  | Scalar components in one accessor, including worker output indices                                          |
| `maxTotalAccessorValues` | 67,108,864  | Declared accessor components plus expanded primitive attributes/morph deltas and channel times/values       |
| `maxPoseValues`          | 4,194,304   | Logical TRS/morph components across nodes, including omitted default weights                                |
| `maxNodes`               | 100,000     | All nodes, including nodes outside the default scene                                                        |
| `maxDefinitions`         | 100,000     | Each resource table, total primitives, per-primitive morph targets and decoder-created accessor/view counts |
| `maxAnimationChannels`   | 100,000     | Total channels; events in each clip also use this ceiling                                                   |
| `maxAnimationKeys`       | 4,194,304   | Input keys per channel, counting repeated sampler use                                                       |
| `maxImageDimension`      | 16,384      | Width or height of an image                                                                                 |
| `maxImagePixels`         | 67,108,864  | Base pixels in one image                                                                                    |
| `maxTotalImagePixels`    | 134,217,728 | Sum of image base pixels, including fallback images                                                         |

These defaults are tunable application policy, not glTF specification limits or a promise that every GPU supports these dimensions. Transport chunk concatenation, parsed JSON, JS number arrays, authored mip levels, browser bitmap storage and native decoder working memory can add temporary memory beyond these counters. Draco's internal mesh decode happens before it exposes counts; compressed-input bounds and worker termination limit that stage, but this is not a hard WASM heap quota. PNG/JPEG checks inspect headers, not complete image bitstreams; native decoding can still reject an image later within transactional GPU preparation. Optional unknown extension/extra data is not a complete schema-validation target. HDR environment loading has its own boundary and is not included in the glTF load budget.

The supported accessor shapes remain SCALAR/VEC2/VEC3/VEC4 and float MAT4; this change does not add integer matrix padding or claim full glTF conformance. Validation follows the relevant [Khronos glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) structures while retaining this project's documented support surface.

## Regression coverage

`tests/asset-validation.test.ts` exercises malformed JSON/reference shapes, huge/fractional declarations, all-node cycles, byte budgets, sparse ordering, invalid floats/indices, animation expansion and keys, skin weights, PNG/JPEG/KTX2 dimensions, misleading/missing HTTP lengths, stream cancellation, worker cancellation and registry retry. A CPU test verifies that failed decoding cannot publish a replacement world or change the existing model. The viewer browser fixture verifies an oversized replacement is rejected before dependency fetch, retains the rendered scene and permits retry. Existing compressed geometry/texture browser fixtures verify real worker decoding and unchanged material slot behavior.

Verified locally on October 2, 2026: 234 CPU tests, 86 offline WebGPU tests and four remote sample tests passed. Remote checks include DamagedHelmet, ChronographWatch, SimpleSkin and AnimatedMorphCube. Production build, browser type checks, formatting and production Draco/Basis plus playable WASM startup also passed. These checks cover the exercised contracts; they do not establish exhaustive glTF conformance or a hard decoder heap quota.
