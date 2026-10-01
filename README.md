# WebGPU glTF renderer

A small, commented TypeScript renderer for glTF 2.0 scenes, built directly on WebGPU. It supports static scenes, animation clips, linear blend skinning, and morph targets. It includes a browser viewer, an offline demo, and tests for the parts where glTF's data layout does not map directly to WebGPU.

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

Models with animation clips show a clip selector, Play/Pause, Restart, and a timeline. The first clip plays automatically and loops over its duration. Scrubbing pauses playback; selecting **Authored pose** restores the original TRS and morph weights. Only one clip plays at a time. Models with skinning or morph weights also render correctly without an animation clip.

## Code map

| Module                               | Responsibility                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `src/main.ts`                        | UI events, serialized loading, status and errors                                |
| `src/gltf/types.ts`                  | Typed subset of the glTF JSON schema                                            |
| `src/gltf/loader.ts`                 | JSON/GLB parsing, URI resolution, buffer and image loading                      |
| `src/gltf/accessors.ts`              | Strided component decoding, normalization, sparse overlays, bounds checks       |
| `src/gltf/geometry.ts`               | Canonical GPU layouts, exceptional repacking, index/topology conversion         |
| `src/gltf/scene.ts`                  | Selected-scene traversal, world/normal matrices, instance collection            |
| `src/gltf/animation.ts`              | Validated animation tracks, interpolation, clip metadata, reusable node poses   |
| `src/animation/controller.ts`        | Playback state, clip selection, frame timing, looping, seeking, pose evaluation |
| `src/gltf/deformation.ts`            | Validated deformation inputs, joint palettes, bounds, CPU reference evaluator   |
| `src/renderer/deformation.ts`        | Compute pipeline, node-owned GPU buffers, pose uploads and dispatch             |
| `src/renderer/deformation-shader.ts` | WGSL morphing and linear blend skinning kernel                                  |
| `src/renderer/resources.ts`          | Padded uploads and explicit GPU allocation ownership                            |
| `src/renderer/materials.ts`          | Cached images/samplers/material bind groups and uniform packing                 |
| `src/renderer/shader.ts`             | Commented WGSL generated for available vertex inputs                            |
| `src/renderer/pipelines.ts`          | Immutable-state pipeline keys and cached async compilation                      |
| `src/renderer/renderer.ts`           | Scene preparation, batching, transparent ordering, rendering and disposal       |
| `src/renderer/camera.ts`             | Orbit controls, scene framing, WebGPU depth projection                          |
| `src/demo.ts`                        | Original procedural glTF demo                                                   |

## How the case study informs the implementation

### Do work when loading, not when drawing

The loader resolves bytes and images first. `Renderer.prepare()` traverses the scene and prepares geometry, transforms, materials, bind groups, and pipelines before displaying it. Static frames update only the camera uniform, sort transparent draws, and submit prepared draw records. Animated frames have a separate pose/deformation update before draw submission. Accessors and tracks are decoded at load time; playback does not create GPU allocations or pipelines (apart from recreating the depth attachment on resize).

### Normalize vertex offsets and preserve interleaving

For float attributes, the renderer uploads each referenced bufferView once. Attributes sharing the same bufferView, stride, and record base share a binding. A large accessor offset is split into a buffer binding base and a small within-record offset. Only the latter enters `GPUVertexAttribute.offset`; the base is passed to `setVertexBuffer()`. Separate planar ranges remain separate bindings even when they share a bufferView.

Attributes use fixed shader locations and are sorted before buffers are ordered. Pipeline keys therefore do not depend on JSON property order or buffer IDs. Sparse and integer attributes are repacked as floats because WebGPU does not directly support every glTF vertex format (notably packed integer VEC3s). This trades load-time work and some memory for simpler shader interfaces. POSITION is required to be float VEC3; required quantization/compression extensions are rejected.

All GPU buffer allocations are rounded up to four bytes. Initial uploads use mapped buffers so byte-sized source data and odd uint16 index counts do not need padded source arrays. Byte indices are promoted to uint16; index streams containing values reserved for uint16 strip restart use uint32. Line loops and triangle fans become indexed lists during preparation.

### Cache immutable state

`PipelineCache` keys contain canonical vertex layouts, topology, strip index format, available shader inputs, blending, culling, and winding. Uniform values, texture identities, absolute buffer offsets, and node IDs are excluded. Color target format, depth format, and bind group layouts are fixed for a renderer and do not need redundant key fields. Pipeline creation is asynchronous and finishes before the scene is swapped in.

Shaders vary only when NORMAL, TEXCOORD_0, COLOR_0, or TANGENT inputs differ. Alpha cutoff, normal-map presence, and unlit behavior are uniform-driven. Missing UVs use zero coordinates and missing colors use white. Missing normals use fragment derivatives for flat triangle lighting. Every material has the same bind group layout with all five core glTF texture slots. Neutral one-pixel textures supply defaults without extra pipeline variants. A new scene receives a fresh cache so loading many unrelated assets cannot grow the pipeline cache indefinitely.

Emission is `emissiveFactor * sampledEmissiveColor` in linear space. Without an emissive texture, the white default preserves factor-only emission; the default factor is zero. A factor of `[1, 1, 1]` with a mostly black map must emit only where the map is bright. Ignoring that map and adding its factor alone turns models such as DamagedHelmet white and hides their base-color details.

### Sample each texture according to its meaning

The implementation follows the channel and transfer-function rules in the [glTF material specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials):

| Texture slot       | Encoding and channels          | Application                                                      | Default                                 |
| ------------------ | ------------------------------ | ---------------------------------------------------------------- | --------------------------------------- |
| Base color         | sRGB RGB, linear alpha         | Multiply base-color factor and vertex color                      | White                                   |
| Emissive           | sRGB RGB                       | Multiply emissive factor and add emitted light                   | White (factor defaults to zero)         |
| Metallic/roughness | Linear B / G                   | Multiply metallic / roughness factors                            | White                                   |
| Normal             | Linear RGB → tangent-space XYZ | Scale XY by `normalTexture.scale`, transform and normalize       | Flat normal; bypass mapping when absent |
| Occlusion          | Linear R                       | `mix(1, R, occlusionTexture.strength)` scales ambient light only | White                                   |

Each slot resolves its own sampler, even when image sources are shared. The image cache includes the GPU format: using the same image in a color slot and a data slot creates separate uploads so data channels never receive sRGB decoding. Metallic/roughness and occlusion can reuse the same linear image upload, including packed ORM maps.

Authored VEC4 tangents use XYZ for the tangent and W for bitangent handedness. Tangents transform with the world matrix, while normals use the inverse transpose; the shader orthogonalizes the tangent against the interpolated normal. Negative-determinant node transforms also reverse tangent handedness. When tangents are absent, the shader reconstructs a triangle-local basis from position/UV derivatives. Degenerate UVs retain the surface normal. If normals are absent, authored tangents are ignored and the derivative basis uses flat normals. All samples and derivatives run before alpha-mask discard. Back faces reverse the complete mapped normal before lighting.

The derivative fallback is useful for assets such as DamagedHelmet, but is not MikkTSpace tangent generation and may differ at seams from the basis used when baking the map. Export authored tangents for the closest match. No normal-map-specific pipeline variant is needed: a material uniform controls its use.

### Instance and order draws

The selected scene's initial parent transforms are accumulated once. Each instance stores a world matrix and its inverse transpose as two mat4 values (128 bytes, matching WGSL storage alignment). Primitive instance ranges are packed into one scene storage buffer, bound once, and addressed with `instance_index` and `firstInstance`. Static nodes referencing the same opaque primitive are drawn together. Transform records are duplicated for each primitive of a multi-primitive mesh; this keeps ranges contiguous and avoids another indirection in this teaching renderer. Static data is never uploaded again each frame.

Scenes with clips use individual node draws, and skinned/morphed nodes always own their deformation streams. This preserves independent poses and morph weights when multiple nodes share a mesh. Original UV/color bufferViews and index buffers remain shared. Both winding pipelines are prepared at load time for pose-dependent draws, allowing animated scales to cross zero and become negative without creating pipelines during playback. The active draw is submitted only in its current winding group. Transparent draw centers are updated with the pose before sorting.

Opaque draws are grouped **pipeline → material → primitive**, reducing pipeline and material bind changes. Negative-determinant transforms use a separate winding pipeline and instance batch. Blended draws disable depth writes and are submitted after opaque geometry, back to front by transformed primitive center along the camera direction. Transparent instances deliberately use individual draws, since their ordering changes with the camera. Center sorting cannot correctly resolve intersecting triangles or every concave transparent mesh; order-independent transparency is outside this renderer's scope.

### Make ownership explicit

Every scene owns its buffers and textures through `Resources`. A replacement is prepared before the current scene is destroyed; failed loads destroy their temporary allocations. ImageBitmaps are closed after upload, depth textures are recreated on canvas-size changes, and `Renderer.destroy()` cancels animation, removes camera listeners, releases allocations, and destroys the device. Device loss and uncaptured GPU errors stop rendering and display a message. Loading is serialized in the UI; callers using the renderer directly should also await each `setAsset()` call.

## Supported behavior and limits

- glTF JSON and GLB 2.0, relative/data URI buffers and images, and embedded GLB images.
- Selected/default scene, hierarchy, matrix or TRS transforms, repeated mesh instancing, and inverse-transpose normals for nonuniform scales.
- Indexed/non-indexed points, lines, line strips/loops, triangles, triangle strips/fans. Missing normals give useful flat shading for triangles; supply normals or an unlit material for points/lines.
- Float POSITION/NORMAL/UV/COLOR/TANGENT plus decoded normalized integer UV/color attributes and sparse accessors. Only TEXCOORD_0 and COLOR_0 are consumed; additional sets are ignored.
- All five core material textures: base color, emissive, metallic/roughness, normal (with scale), and occlusion (with strength). Material factors, vertex colors, OPAQUE/MASK/BLEND, double-sided materials, and KHR_materials_unlit are supported.
- JPEG/PNG browser-decoded images, wrap/filter sampler translation, and linear-light shading with sRGB decoding for color maps and linear sampling for data maps.

This is **not a complete glTF conformance implementation or a full PBR viewer**. Lighting uses a GGX-style direct light plus a simple ambient term. It has no environment lighting, shadows, exposure/tone mapping, antialiasing, frustum culling, or mipmap generation. Samplers are clamped to level zero; distant textured surfaces can alias. Blending operates on encoded canvas colors rather than a separate linear offscreen target.

Texture transforms and TEXCOORD sets other than zero are rejected for every supported texture slot. Authored glTF cameras/lights are ignored in favor of orbit controls and the viewer light. Unsupported required extensions (including Draco, meshopt, KTX2, and quantization) are rejected. Optional extensions are not applied except KHR_materials_unlit. The parser performs targeted integrity checks but is not a substitute for the Khronos glTF Validator. Normal mapping is intended for triangles; supply unlit materials for points/lines without meaningful surface normals.

## Animation and deformation

The implementation follows the [glTF animation and skinning rules](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#animations). `Pose` stores immutable authored defaults and reusable translation, rotation, scale, morph-weight, and world-matrix arrays. Clip changes reset every animated property before applying the new clip. World matrices are updated in a prepared parent-first order. Track inputs are strictly increasing times in seconds and are clamped outside their key range.

- **STEP** holds the preceding key, including the correct value at an exact key time.
- **LINEAR** interpolates vectors/weights and uses shortest-path quaternion slerp for rotations.
- **CUBICSPLINE** uses Hermite interpolation with incoming/outgoing tangents scaled by the key interval in seconds. Rotations are normalized after interpolation. Weight outputs are unpacked by key, target, and tangent/value group.
- **Morph targets** add weighted POSITION/NORMAL/TANGENT deltas to immutable base attributes. Node weights override mesh defaults, and omitted weights are zero. Sparse target accessors are supported. Tangent morphs change XYZ while preserving the base handedness component.
- **Skinning** supports JOINTS_n/WEIGHTS_n influence sets, normalized integer weights, and optional float MAT4 inverse-bind matrices. Missing inverse binds are identity matrices. Joint matrices are `jointWorld * inverseBind`; weights are normalized across all influence sets for each vertex. Skinning follows morphing. Skinned positions are already world-space, so their draw uses an identity instance transform: the skinned mesh node's transform is not applied a second time. Normals use the inverse transpose of the blended transform and tangents use its linear part.

Deformation runs in a **WebGPU compute pass** before drawing. CPU animation sampling still evaluates node transforms and computes `jointWorld * inverseBind` palettes, but playback uploads only those matrices, morph weights, and instance transforms. Immutable base vertices, dense decoded morph deltas, and joint influences are uploaded when loading. Each 64-thread workgroup processes vertices independently, with a bounds guard for the final partial workgroup. Every invocation starts from the immutable base, applies morph deltas, then skins the result. The output buffer has STORAGE and VERTEX usage and is bound directly for drawing; there is no per-frame vertex upload or GPU readback.

The shared compute pipeline uses one explicit bind group layout for skin-only, morph-only, and combined deformation. Unused slots receive neutral buffers. Base, target, and output records contain three vec4s (position, normal, tangent), for a 48-byte stride matching [WGSL alignment rules](https://gpuweb.github.io/gpuweb/wgsl/#alignment-and-size). Position W is one, normal W and morph delta W are zero, and tangent W preserves handedness. Influence records contain a vec4u of joint indices followed by a vec4f of weights. The kernel computes inverse-transpose normals from the blended matrix's cofactors and determinant, with an identity fallback for singular transforms.

The renderer ends the compute pass before starting the render pass in the same command encoder. WebGPU orders these uses of the output buffer; no shader barrier or CPU wait is required between passes. Paused poses retain their GPU output until a seek or clip change. Static scenes retain the optimized instanced path and do not create a compute pipeline. Buffers and workgroup counts are checked against device limits; oversized deformation inputs are rejected rather than silently truncated. Outputs are owned by the scene and destroyed together on replacement or a failed load.

The CPU deformation evaluator remains an oracle for tests and runs once on load for exact initial camera bounds. Playback uses precomputed base/delta bounds, expands them for signed morph weights, and unions joint-transformed envelopes to estimate transparent draw centers. This takes work proportional to target/joint counts rather than vertex counts and avoids GPU readbacks. Those conservative centers can be less accurate than centers of the deformed vertices; intersecting transparent meshes still have the usual draw-sorting limitations. GPU inputs currently belong to each deforming node; large crowds would benefit from sharing immutable deformation buffers and batching dispatches.

Playback is single-clip and looping, with no blending, crossfades, animation-pointer extensions, or runtime retargeting. Camera framing uses the initial authored pose rather than the whole animation's swept bounds; zoom out if a clip moves beyond the initial view. Degenerate transforms use a safe normal-matrix fallback; collapsed geometry has no well-defined surface normal. Models containing unsupported required extensions remain rejected.

`AnimationController` owns playback state and timing independently of WebGPU and the DOM. It selects clips, clamps seeks, loops time, handles pause/resume, and evaluates the attached `Pose`. The renderer calls `animation.update(frameTimestamp)`; a true result requests a render-side pose upload followed by GPU deformation. Static and paused poses return false until their state changes. A new pose is attached only after scene preparation succeeds, so failed replacements preserve playback. The controller does not schedule frames or allocate GPU resources.

For programmatic playback, await `renderer.setAsset(asset)`, then use `renderer.animation.select(index)` (`-1` for authored pose), `renderer.animation.setPlaying(boolean)`, and `renderer.animation.seek(seconds)`. `renderer.animation.state` exposes clip names, selected index, time, duration, and playback state. Set `renderer.animation.onChange` to update UI after state changes and evaluated frames. The original renderer methods (`selectAnimation`, `setPlaying`, `seek`), `animationState`, and `onAnimationChange` remain forwarding aliases for existing callers.

## Extending the renderer

Keep material texture slots on the same explicit bind group layout across variants, with neutral defaults. Decode color textures as sRGB and data textures as linear. Add shader flags only when they materially change the interface or algorithm. Preserve the separate pose-upload, compute, and render phases when adding deformation features. Larger scenes should split buffers at device limits. Keep new rendering features isolated from file parsing and test their layout or ordering edge cases.

## Verification

`tests/gltf.test.ts` checks interleaved grouping, large attribute offsets, deterministic pipeline keys, byte indices, fan conversion, bounds failures, sparse normalized data, scene selection, parent transforms, mirrored winding, singular/cyclic scenes, and GLB chunk validation. These are CPU tests; they do not prove shader compilation or visible rendering.

`browser-tests/viewer.spec.ts` runs the real viewer in installed Microsoft Edge with WebGPU enabled. It checks the offline instancing demo, resizing and camera controls, a generated textured scene with normalized integer UV/colors and missing normals, MASK/BLEND materials, mirrored transforms, local GLB loading, and recovery from an unsupported model. The emissive regression examines rendered pixels to catch color washout, rather than only asserting that the asset loaded. Screenshots are saved under `test-results/` for visual inspection. The browser must have a usable GPU adapter; this suite intentionally fails if WebGPU is unavailable. Change `channel` in `playwright.config.ts` to use another installed Chromium browser.

`browser-tests/textures.spec.ts` compares presented pixels against equivalent factor-only materials to check metallic/roughness G/B channels and linear decoding, including an image reused for both color and data. It checks that occlusion strength changes only the expected ambient contribution and that normal scale zero preserves surface normals. It also compares authored and derivative tangent bases under nonuniform and mirrored transforms. These fixtures run offline.

The DamagedHelmet regression loads the public Khronos GLB with all five material textures and requires network access. It is skipped by default. To include it in PowerShell:

`tests/animation.test.ts` also covers key clamping, STEP boundaries, cubic tangent timing, normalized and shortest-path rotations, clip resets, morph-before-skin ordering, inverse binds, independent node weights, sparse targets, multiple influence sets, and malformed inputs. `browser-tests/animation.spec.ts` verifies rendered changes during node motion, skinning, and morph playback, paused-frame stability, scrubbing, and authored-pose restoration. Optional network tests load Khronos SimpleSkin and AnimatedMorphCube. Set TEST_REMOTE_MODELS as below to include these public-asset regressions.

`browser-tests/compute.spec.ts` dispatches the production kernel on the real GPU and reads output back only for testing. It compares positions, normals, and tangents against the CPU oracle for skin-only, morph-only, combined, sparse, multiple-influence, reflected/nonuniform, and singular cases. Its 69-vertex fixtures exercise partial workgroups, and repeated dispatches change weights and joint matrices to detect accumulation and stale uploads.

`tests/animation-controller.test.ts` verifies frame-time conversion and looping, pause/resume without time jumps, paused seeks, authored-pose restoration, scene replacement, static-pose reuse, notifications, and invalid playback requests without requiring a GPU or browser.

```powershell
$env:TEST_REMOTE_MODELS = '1'
npm run test:browser
Remove-Item Env:TEST_REMOTE_MODELS
```

Test your own textured and transparent assets before depending on broader feature coverage.
