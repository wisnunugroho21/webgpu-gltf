# GPU texture compression

The renderer retains Basis KTX2 block data in GPU textures when the adapter supports a suitable format. This reduces upload and texture storage without changing material bindings, shader slot interpretation, animation or rendering phases.

## Target policy and portability

Renderer initialization intersects adapter features with `texture-compression-bc`, `texture-compression-etc2` and `texture-compression-astc`, then requests that set. Selection uses enabled device features, not adapter claims alone. `renderer.textureCompression` exposes plain `bc`/`etc2`/`astc` capabilities to CPU loaders.

| Encoding | Preferred supported targets    | Fallback |
| -------- | ------------------------------ | -------- |
| UASTC    | ASTC 4×4, BC7 RGBA, ETC2 RGBA8 | RGBA8    |
| ETC1S    | BC7 RGBA, ETC2 RGBA8           | RGBA8    |

All selected targets preserve RGBA channels. The bundled WASM API uses format IDs 10 for ASTC 4×4, 6 for BC7, 1 for ETC2 RGBA, and 13 for RGBA32. These match the bundled Three.js KTX2 loader's transcoder definitions and [Basis Universal's format definitions](https://github.com/BinomialLLC/basis_universal/blob/master/transcoder/basisu_transcoder.h). No Three.js rendering code is imported. ASTC is selected only for UASTC because the bundled transcoder does not offer that target for ETC1S.

Compressed base dimensions must be multiples of four. Other dimensions remain RGBA8 rather than padding the image and changing normalized UV behavior. Single-level KTX2 sources remain RGBA8 so the existing GPU mip generator can create lower levels; compressed render attachments are unavailable. Authored partial/full multi-level chains remain intact. Malformed containers and inconsistent level payload sizes still reject the candidate; fallback does not hide decoding errors.

`loadUrl(url)` and `loadFiles(files)` preserve the default portable RGBA8 output. Pass `{ textureCompression: renderer.textureCompression }` to transcode directly to a device-compatible target. The test-only loading fixture uses this option. Scene preparation automatically adapts assets loaded without options or for another device using original KTX2 image blobs, leaving the caller's decoded images untouched. Deliberate RGBA fallbacks record the capabilities used to avoid immediately redoing the same transcode. One short-lived worker serves the preparation operation and terminates on success or failure.

## GPU upload and color contract

The slot decides the transfer function. BC7 color slots use `bc7-rgba-unorm-srgb`, ETC2 use `etc2-rgba8unorm-srgb`, and ASTC use `astc-4x4-unorm-srgb`. Data slots use corresponding linear formats. Color/data uses of one source get separate allocations; compatible slots reuse textures. The explicit twelve-slot layout and neutral default textures remain unchanged.

Every selected compressed target has 16-byte 4×4 blocks. Each mip's payload is `ceil(width/4) * ceil(height/4) * 16` bytes. Copies use those block row pitches and physical extents rounded to four texels, including 2×2 and 1×1 tails; texture dimensions remain logical. This follows [WebGPU's compressed texture and copy rules](https://gpuweb.github.io/gpuweb/#texture-formats). Compressed textures use only `TEXTURE_BINDING | COPY_DST`; authored blocks are never sent through the render-based mip generator. Samplers, UV transforms and anisotropy continue unchanged.

## Measured payloads and verification

Each original ETC1S/UASTC fixture is 40×40 with six authored mips:

| Storage          | Bytes per complete fixture chain |
| ---------------- | -------------------------------: |
| RGBA8            |                            8,520 |
| BC7 RGBA         |                            2,240 |
| ETC2 RGBA8       |                            2,240 |
| ASTC 4×4 (UASTC) |                            2,240 |

This is about 74% less payload. Large mip levels approach 75% savings; small mip tails still occupy whole blocks. Counts exclude allocator padding, driver overhead and duplicate allocations when one image serves color and data. They measure payload/storage requests, not physical VRAM residency.

The local Edge WebGPU device exposed BC compression. Tests uploaded and rendered ETC1S and UASTC as BC7 in both sRGB and linear formats, checked that compatible slots shared allocations, and validated mip-tail copies. Existing pixel regressions compare color/data-slot rendering against equivalent PNG textures. A feature-free device validated RGBA uploads of re-transcoded assets. WASM tests also verified ETC2 blocks and UASTC ASTC blocks; GPU sampling of those formats needs hardware exposing their optional features and was not verified on this device.

```sh
npm test
npm run build
npx playwright test browser-tests/gpu-compression.spec.ts browser-tests/compression.spec.ts
npm run test:compressed-build
```

The production test exercises emitted decoder/WASM URLs and the serialized worker through an isolated production build of the test-only loading fixture. Remaining format limits are unchanged: only 2D ETC1S/UASTC Basis KTX2, without arrays, cubemaps, HDR Basis payloads, raw `.basis`, or arbitrary native-compressed KTX2 containers.
