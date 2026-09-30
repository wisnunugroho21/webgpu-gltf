# WebGPU glTF renderer

A small, commented TypeScript renderer for static glTF 2.0 scenes, built directly on WebGPU. It includes a browser viewer, an offline demo, and tests for the parts where glTF's data layout does not map directly to WebGPU.

The architecture follows [Toji's “Efficiently rendering glTF models” case study](https://toji.dev/webgpu-gltf-case-study/). It is an independent implementation, not a copy of the sample renderer. As in the article, the focus is efficient data preparation and draw submission rather than full glTF feature coverage.

## Run

Use Node.js 22.12+ (Node.js 24 recommended) and a browser/device with WebGPU enabled.

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. WebGPU needs a secure context: localhost works for development; deployment needs HTTPS. If no GPU adapter is available, the viewer displays an error instead of silently falling back to another renderer.

```sh
npm test          # CPU-side glTF and layout regression tests
npm run build    # Strict TypeScript check and production bundle
npm run preview  # Serve the production bundle locally
npm run test:browser # Real WebGPU integration tests in installed Microsoft Edge
```

The first scene is generated locally and makes no network requests for models. Three green cubes share one primitive, so they render in one instanced draw; the orange cube shares the pipeline but uses a different material. The demo reports **1 pipeline, 2 draws, and 4 primitive instances**.

Use **Open model** to select one `.glb`, or one `.gltf` together with its binary and image dependencies. Local dependencies are matched by decoded URI or filename; assets with different dependencies sharing the same filename should be served by URL instead. **Load URL** accepts a model URL and resolves dependencies relative to it. Cross-origin servers must enable CORS. Drag to orbit, scroll to zoom, and use **Reset camera** to return to the fitted view.

## Code map

| Module                      | Responsibility                                                            |
| --------------------------- | ------------------------------------------------------------------------- |
| `src/main.ts`               | UI events, serialized loading, status and errors                          |
| `src/gltf/types.ts`         | Typed subset of the glTF JSON schema                                      |
| `src/gltf/loader.ts`        | JSON/GLB parsing, URI resolution, buffer and image loading                |
| `src/gltf/accessors.ts`     | Strided component decoding, normalization, sparse overlays, bounds checks |
| `src/gltf/geometry.ts`      | Canonical GPU layouts, exceptional repacking, index/topology conversion   |
| `src/gltf/scene.ts`         | Selected-scene traversal, world/normal matrices, instance collection      |
| `src/renderer/resources.ts` | Padded uploads and explicit GPU allocation ownership                      |
| `src/renderer/materials.ts` | Cached images/samplers/material bind groups and uniform packing           |
| `src/renderer/shader.ts`    | Commented WGSL generated for available vertex inputs                      |
| `src/renderer/pipelines.ts` | Immutable-state pipeline keys and cached async compilation                |
| `src/renderer/renderer.ts`  | Scene preparation, batching, transparent ordering, rendering and disposal |
| `src/renderer/camera.ts`    | Orbit controls, scene framing, WebGPU depth projection                    |
| `src/demo.ts`               | Original procedural glTF demo                                             |

## How the case study informs the implementation

### Do work when loading, not when drawing

The loader resolves bytes and images first. `Renderer.prepare()` traverses the scene and prepares geometry, transforms, materials, bind groups, and pipelines before displaying it. A frame updates only the camera uniform, sorts transparent draws, and submits the prepared draw records. There is no scene-tree traversal, accessor decoding, GPU allocation, or pipeline compilation in the normal draw path (apart from recreating the depth attachment on resize).

### Normalize vertex offsets and preserve interleaving

For float attributes, the renderer uploads each referenced bufferView once. Attributes sharing the same bufferView, stride, and record base share a binding. A large accessor offset is split into a buffer binding base and a small within-record offset. Only the latter enters `GPUVertexAttribute.offset`; the base is passed to `setVertexBuffer()`. Separate planar ranges remain separate bindings even when they share a bufferView.

Attributes use fixed shader locations and are sorted before buffers are ordered. Pipeline keys therefore do not depend on JSON property order or buffer IDs. Sparse and integer attributes are repacked as floats because WebGPU does not directly support every glTF vertex format (notably packed integer VEC3s). This trades load-time work and some memory for simpler shader interfaces. POSITION is required to be float VEC3; required quantization/compression extensions are rejected.

All GPU buffer allocations are rounded up to four bytes. Initial uploads use mapped buffers so byte-sized source data and odd uint16 index counts do not need padded source arrays. Byte indices are promoted to uint16; index streams containing values reserved for uint16 strip restart use uint32. Line loops and triangle fans become indexed lists during preparation.

### Cache immutable state

`PipelineCache` keys contain canonical vertex layouts, topology, strip index format, available shader inputs, blending, culling, and winding. Uniform values, texture identities, absolute buffer offsets, and node IDs are excluded. Color target format, depth format, and bind group layouts are fixed for a renderer and do not need redundant key fields. Pipeline creation is asynchronous and finishes before the scene is swapped in.

Shaders vary only when NORMAL, TEXCOORD_0, or COLOR_0 inputs differ. Alpha cutoff and unlit behavior are uniform-driven. Missing UVs use zero coordinates and missing colors use white. Missing normals use fragment derivatives for flat triangle lighting. Every material has the same bind group layout and always binds a base-color texture; a shared white pixel supplies the default. A new scene receives a fresh cache so loading many unrelated assets cannot grow the pipeline cache indefinitely.

### Instance and order draws

The selected scene's parent transforms are accumulated once. Each instance stores a world matrix and its inverse transpose as two mat4 values (128 bytes, matching WGSL storage alignment). Primitive instance ranges are packed into one scene storage buffer, bound once, and addressed with `instance_index` and `firstInstance`. Nodes referencing the same opaque primitive are drawn together. Transform records are duplicated for each primitive of a multi-primitive mesh; this keeps ranges contiguous and avoids another indirection in this teaching renderer. Static data is never uploaded again each frame.

Opaque draws are grouped **pipeline → material → primitive**, reducing pipeline and material bind changes. Negative-determinant transforms use a separate winding pipeline and instance batch. Blended draws disable depth writes and are submitted after opaque geometry, back to front by transformed primitive center along the camera direction. Transparent instances deliberately use individual draws, since their ordering changes with the camera. Center sorting cannot correctly resolve intersecting triangles or every concave transparent mesh; order-independent transparency is outside this renderer's scope.

### Make ownership explicit

Every scene owns its buffers and textures through `Resources`. A replacement is prepared before the current scene is destroyed; failed loads destroy their temporary allocations. ImageBitmaps are closed after upload, depth textures are recreated on canvas-size changes, and `Renderer.destroy()` cancels animation, removes camera listeners, releases allocations, and destroys the device. Device loss and uncaptured GPU errors stop rendering and display a message. Loading is serialized in the UI; callers using the renderer directly should also await each `setAsset()` call.

## Supported behavior and limits

- glTF JSON and GLB 2.0, relative/data URI buffers and images, and embedded GLB images.
- Selected/default scene, hierarchy, matrix or TRS transforms, repeated mesh instancing, and inverse-transpose normals for nonuniform scales.
- Indexed/non-indexed points, lines, line strips/loops, triangles, triangle strips/fans. Missing normals give useful flat shading for triangles; supply normals or an unlit material for points/lines.
- Float POSITION/NORMAL/UV/COLOR plus decoded normalized integer UV/color attributes and sparse accessors. Only TEXCOORD_0 and COLOR_0 are consumed; tangents and additional attributes are ignored.
- Base-color factors and textures, vertex colors, metallic/roughness factors, emissive factors, OPAQUE/MASK/BLEND, double-sided materials, and KHR_materials_unlit.
- JPEG/PNG browser-decoded base-color images, wrap/filter sampler translation, and linear-light shading with sRGB texture decoding and output encoding.

This is **not a complete glTF conformance implementation or a full PBR viewer**. Lighting uses a GGX-style direct light plus a simple ambient term. It has no environment lighting, shadows, exposure/tone mapping, antialiasing, frustum culling, or mipmap generation. Samplers are clamped to level zero; distant textured surfaces can alias. Blending operates on encoded canvas colors rather than a separate linear offscreen target.

Normal, occlusion, emissive, and metallic/roughness **textures** are ignored with a visible warning; their supported factors remain active. Base-color texture transforms and TEXCOORD sets other than zero are rejected. Skins and morph targets are rejected; animations are ignored with a warning and authored node transforms are displayed. Authored glTF cameras/lights are ignored in favor of orbit controls and the viewer light. Unsupported required extensions (including Draco, meshopt, KTX2, and quantization) are rejected. Optional extensions are not applied except KHR_materials_unlit. The parser performs targeted integrity checks but is not a substitute for the Khronos glTF Validator.

## Extending the renderer

Add material texture slots with neutral default textures and the same explicit bind group layout across variants. Decode color textures as sRGB and data textures as linear. Add shader flags only when they materially change the interface or algorithm, rather than for every material value. Dynamic transforms need a COPY_DST storage buffer and an update phase separate from draw submission; larger scenes should split buffers at device limits. Keep new rendering features isolated from file parsing and test their layout or ordering edge cases.

## Verification

`tests/gltf.test.ts` checks interleaved grouping, large attribute offsets, deterministic pipeline keys, byte indices, fan conversion, bounds failures, sparse normalized data, scene selection, parent transforms, mirrored winding, singular/cyclic scenes, and GLB chunk validation. These are CPU tests; they do not prove shader compilation or visible rendering.

`browser-tests/viewer.spec.ts` runs the real viewer in installed Microsoft Edge with WebGPU enabled. It checks the offline instancing demo, resizing and camera controls, a generated textured scene with normalized integer UV/colors and missing normals, MASK/BLEND materials, mirrored transforms, local GLB loading, and recovery from an unsupported model. Screenshots are saved under `test-results/` for visual inspection. The browser must have a usable GPU adapter; this suite intentionally fails if WebGPU is unavailable. Change `channel` in `playwright.config.ts` to use another installed Chromium browser. Test your own textured and transparent assets before depending on broader feature coverage.
