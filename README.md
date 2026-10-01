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

The first scene is generated locally and makes no network requests for models. Three green cubes share one primitive, so they render in one instanced draw; the orange cube shares the pipeline but uses a different material. The demo reports **1 pipeline, 2 draws, and 4 primitive instances**. These counts describe scene geometry; the fixed fullscreen presentation pipeline and draw are additional.

Use **Open model** to select one `.glb`, or one `.gltf` together with its binary and image dependencies. Local dependencies are matched by decoded URI or filename; assets with different dependencies sharing the same filename should be served by URL instead. **Load URL** accepts a model URL and resolves dependencies relative to it. Cross-origin servers must enable CORS. Drag to orbit, scroll to zoom, and use **Reset camera** to return to the fitted view.

Models with animation clips show a clip selector, Play/Pause, Restart, and a timeline. The first clip plays automatically and loops over its duration. Scrubbing pauses playback; selecting **Authored pose** restores the original TRS and morph weights. Only one clip plays at a time. Models with skinning or morph weights also render correctly without an animation clip.

Display controls select **Reinhard** tone mapping (default) or **None**, and adjust exposure from −6 to +6 EV. One extra EV doubles linear brightness; negative exposure reveals highlight detail. None retains the HDR rendering path but clips display values above one after exposure. Display settings persist across model replacements and do not rebuild scene pipelines.

The viewer enables **4× MSAA** by default to smooth geometry silhouettes and intersections. Color and depth use four samples per pixel; the scene resolves into linear HDR before exposure and tone mapping. Antialiasing persists across model and environment replacements.

Environment lighting starts with an original, generated HDR **Studio** panorama. **Open environment** accepts an equirectangular PNG/JPEG panorama (typically 2:1, longitude across X and north pole at the top). Adjust **Intensity** or rotate it around the vertical axis with **Rotation**. Studio restores the default map. Map and lighting settings persist across model loads; failed environment loads retain the current lighting. Environment intensity zero disables its contribution while retaining the existing directional light and small ambient term.

## Code map

| Module                               | Responsibility                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `src/main.ts`                        | UI events, serialized loading, status and errors                                   |
| `src/gltf/types.ts`                  | Typed subset of the glTF JSON schema                                               |
| `src/gltf/loader.ts`                 | JSON/GLB parsing, URI resolution, buffer and image loading                         |
| `src/gltf/accessors.ts`              | Strided component decoding, normalization, sparse overlays, bounds checks          |
| `src/gltf/geometry.ts`               | Canonical GPU layouts, exceptional repacking, index/topology conversion            |
| `src/gltf/texture-coordinates.ts`    | UV-set selection, texture-transform validation and affine-row packing              |
| `src/gltf/scene.ts`                  | Selected-scene traversal, world/normal matrices, instance collection               |
| `src/gltf/animation.ts`              | Validated animation tracks, interpolation, clip metadata, reusable node poses      |
| `src/animation/controller.ts`        | Playback state, clip selection, frame timing, looping, seeking, pose evaluation    |
| `src/gltf/deformation.ts`            | Validated deformation inputs, joint palettes, bounds, CPU reference evaluator      |
| `src/renderer/deformation.ts`        | Compute pipeline, node-owned GPU buffers, pose uploads and dispatch                |
| `src/renderer/deformation-shader.ts` | WGSL morphing and linear blend skinning kernel                                     |
| `src/renderer/resources.ts`          | Padded uploads and explicit GPU allocation ownership                               |
| `src/renderer/materials.ts`          | Cached images/samplers/material bind groups and uniform packing                    |
| `src/renderer/material-slots.ts`     | Shared texture slot bindings, color spaces, neutral defaults and WGSL declarations |
| `src/renderer/mipmaps.ts`            | Cached GPU mipmap generation in linear light                                       |
| `src/renderer/output.ts`             | HDR/MSAA viewport targets, linear resolve, exposure, tone mapping and presentation |
| `src/renderer/environment-source.ts` | Procedural HDR panorama, linear pixel validation and PNG/JPEG decoding             |
| `src/renderer/environment.ts`        | Environment convolution, shared lighting bindings and resource replacement         |
| `src/renderer/environment-shader.ts` | Cosine/GGX environment filtering and split-sum BRDF integration                    |
| `src/renderer/samplers.ts`           | glTF wrap/filter modes and mip-selection policy                                    |
| `src/renderer/shader.ts`             | Commented WGSL generated for available vertex inputs                               |
| `src/renderer/pipelines.ts`          | Immutable-state pipeline keys and cached async compilation                         |
| `src/renderer/renderer.ts`           | Scene preparation, batching, transparent ordering, rendering and disposal          |
| `src/renderer/camera.ts`             | Orbit controls, scene framing, WebGPU depth projection                             |
| `src/demo.ts`                        | Original procedural glTF demo                                                      |

## How the case study informs the implementation

### Do work when loading, not when drawing

The loader resolves bytes and images first. `Renderer.prepare()` traverses the scene and prepares geometry, transforms, materials, bind groups, and pipelines before displaying it. Static frames update only the camera uniform, sort transparent draws, and submit prepared draw records. Animated frames have a separate pose/deformation update before draw submission. Accessors and tracks are decoded at load time; playback does not create GPU allocations or pipelines (apart from recreating viewport attachments on resize).

### Normalize vertex offsets and preserve interleaving

For float attributes, the renderer uploads each referenced bufferView once. Attributes sharing the same bufferView, stride, and record base share a binding. A large accessor offset is split into a buffer binding base and a small within-record offset. Only the latter enters `GPUVertexAttribute.offset`; the base is passed to `setVertexBuffer()`. Separate planar ranges remain separate bindings even when they share a bufferView.

Attributes use fixed shader locations and are sorted before buffers are ordered. Pipeline keys therefore do not depend on JSON property order or buffer IDs. Sparse and integer attributes are repacked as floats because WebGPU does not directly support every glTF vertex format (notably packed integer VEC3s). This trades load-time work and some memory for simpler shader interfaces. POSITION is required to be float VEC3; required quantization/compression extensions are rejected.

All GPU buffer allocations are rounded up to four bytes. Initial uploads use mapped buffers so byte-sized source data and odd uint16 index counts do not need padded source arrays. Byte indices are promoted to uint16; index streams containing values reserved for uint16 strip restart use uint32. Line loops and triangle fans become indexed lists during preparation.

### Cache immutable state

`PipelineCache` keys contain canonical vertex layouts, topology, strip index format, available shader inputs, blending, culling, and winding. Uniform values, texture identities, absolute buffer offsets, and node IDs are excluded. Color target format, depth format, sample count, and bind group layouts are fixed for a renderer and do not need redundant key fields. Pipeline creation is asynchronous and finishes before the scene is swapped in.

Shaders vary only when NORMAL, available TEXCOORD sets, COLOR_0, or TANGENT inputs differ. Alpha cutoff, normal-map presence, UV-set selection, texture transforms, and unlit behavior are uniform-driven. Untextured primitives may omit UVs; every actual texture must reference an available coordinate set. Missing colors use white. Missing normals use fragment derivatives for flat triangle lighting. Every material has the same bind group layout with all five core glTF texture slots. Neutral one-pixel textures supply defaults without extra pipeline variants. A new scene receives a fresh cache so loading many unrelated assets cannot grow the pipeline cache indefinitely.

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

`material-slots.ts` is the single source of truth for the five texture slots. The explicit GPU layout, every material bind group, and all WGSL variants use its binding numbers. Texture presence never changes the interface or adds a pipeline variant. Neutral textures are cached by format and RGBA value, so color and data defaults share allocations only when their formats match. Base-color and emissive RGB decode through `rgba8unorm-srgb`; alpha remains linear. Metallic/roughness, normal, and occlusion use `rgba8unorm`. Missing emissive maps use white to preserve factor-only emission; the default emissive factor is zero. Missing normal maps also bypass perturbation, avoiding the small XY quantization offset in the neutral 8-bit normal texture.

Authored VEC4 tangents use XYZ for the tangent and W for bitangent handedness. Tangents transform with the world matrix, while normals use the inverse transpose; the shader orthogonalizes the tangent against the interpolated normal. Negative-determinant node transforms also reverse tangent handedness. When tangents are absent, the shader reconstructs a triangle-local basis from position/UV derivatives. Degenerate UVs retain the surface normal. If normals are absent, authored tangents are ignored and the derivative basis uses flat normals. All samples and derivatives run before alpha-mask discard. Back faces reverse the complete mapped normal before lighting.

The derivative fallback is useful for assets such as DamagedHelmet, but is not MikkTSpace tangent generation and may differ at seams from the basis used when baking the map. Export authored tangents for the closest match. No normal-map-specific pipeline variant is needed: a material uniform controls its use.

### Select UV coordinates and generate mipmaps

Each of the five texture slots independently selects `textureInfo.texCoord`, defaulting to zero. [KHR_texture_transform](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_transform/README.md) can override that selection and supplies offset, rotation in radians, and scale. The shader applies `offset + rotation * (scale * uv)` before sampling. The extension works both when optional and when listed in `extensionsRequired`. Missing selected UV sets are reported with the slot name and required TEXCOORD semantic, preserving the current scene if replacement fails.

Geometry binds available `TEXCOORD_n` sets in a deterministic order, including normalized integer and sparse accessors. Additional sets receive compact shader locations, so semantic numbering need not be consecutive. Vertex and inter-stage limits still depend on the GPU; this is not unlimited UV storage. Each material uniform contains 64 bytes of factors plus five pairs of vec4 transform rows (32 bytes per slot), for 224 bytes total. Binding numbers and texture defaults are unchanged across variants. The normal slot uses authored tangents only for TEXCOORD_0 with an unchanged linear UV basis; alternate sets, UV rotation, or scale use derivatives of the normal slot's transformed coordinates. Offset alone preserves the authored tangent basis. Degenerate UV transforms retain the geometric normal.

Image uploads allocate a complete mip chain, including non-power-of-two and one-pixel-wide/tall images. `MipmapGenerator` renders each lower level from a view of the preceding level during scene preparation. Color textures use sRGB views: sampling decodes to linear light, filtering averages there, and the sRGB attachment encodes the result. Data textures remain unorm throughout; alpha remains linear in both cases. The generator caches one pipeline per format and mipmaps belong to the scene's texture allocation. No mip generation occurs in the playback pose-upload, compute, or render phases.

All six glTF minification filters map to their corresponding in-level and mip filtering modes. NEAREST/LINEAR without mipmaps clamp sampling to level zero; the four mip filters can select the full chain. An omitted minification filter uses linear filtering with linear mip interpolation. Neutral 1×1 defaults need no generation. Mipmaps add roughly one-third texture memory for large square images. This basic bilinear downsampling does not preserve alpha-mask coverage or adjust material roughness for normal-map variance.

Anisotropic filtering requests up to **16×** for samplers with linear magnification and LINEAR_MIPMAP_LINEAR minification, including the renderer's default sampler. This improves texture detail at oblique viewing angles. [WebGPU requires all three filtering modes to be linear](https://gpuweb.github.io/gpuweb/#dom-gpusamplerdescriptor-maxanisotropy) when anisotropy exceeds one, so authored nearest filtering, nearest mip selection, and non-mip modes retain `maxAnisotropy: 1`. No glTF filter mode is silently overridden. The platform clamps the request to its supported maximum; visual results and cost vary by GPU. `samplerDescriptor(definition, requestedAnisotropy)` accepts integers from 1 to 16, with one disabling the enhancement. Material samplers use the default request of 16; the mip-generation sampler itself remains ordinary bilinear filtering.

### Prepare environment lighting once

`EnvironmentLighting` supplies image-based lighting (IBL) using the split-sum approach described in [Filament's image-based lighting documentation](https://google.github.io/filament/main/filament.html#lighting/imagebasedlights). A panorama is converted into a **16×16 diffuse irradiance cubemap**, a **64×64 specular cubemap with seven roughness mips**, and a **64×64 BRDF integration LUT**. The GPU compute shader uses 128 Hammersley samples per filtered texel: cosine-weighted hemisphere samples store diffuse irradiance divided by π; GGX half-vector importance samples filter specular radiance. Specular level zero samples the panorama directly. Roughness increases linearly from zero to one across levels, so shading selects `roughness * 6`. The BRDF LUT stores the scale/bias terms indexed by N·V and roughness and is generated once per renderer.

Panorama pixels are linear floating-point radiance. PNG/JPEG input converts browser-decoded sRGB RGB to linear once; these formats supply LDR lighting. The generated studio map and API-supplied arrays support values above one. An `rgba32float` panorama uses explicit bilinear `textureLoad` interpolation, wrapping longitude and clamping latitude, avoiding a dependency on optional float32 filtering support. All filtered resources use `rgba16float`. Each dispatch has its own parameter buffer so queued jobs do not accidentally share the final job's parameters. Temporary source textures and buffers are released after GPU preparation completes.

All scene shader variants use one explicit environment bind group at **group 3**: filtering sampler, diffuse cube, specular cube, BRDF LUT, and a 16-byte intensity/rotation/maximum-LOD uniform. The five material texture slots remain unchanged at group 2, including their neutral defaults and color-space rules. Intensity and yaw updates write only uniform data; replacing a panorama reuses the same layout and scene pipelines. Replacement maps are prepared before their bind group is swapped; failure releases candidate resources and preserves the previous map. Renderer disposal releases lighting textures and uniforms.

The fragment shader rotates the world-space surface normal and reflection direction into environment space. Diffuse lighting is suppressed for metals; specular reflection uses the material's metallic F0, roughness-selected radiance, and BRDF LUT. Normal maps influence both terms. Occlusion scales indirect environment light and the existing ambient term, while leaving directional light and emission unchanged. Unlit materials bypass lighting. The resulting linear HDR radiance is blended into the scene attachment before exposure, tone mapping, and display encoding. Environment preparation happens only at initialization or replacement; the animation pose-upload → deformation compute → scene render phases remain separate.

Programmatic callers can supply decoded HDR pixels without depending on a file format:

```ts
// RGBA Float32Array in linear radiance; alpha is ignored by environment filtering.
await renderer.setEnvironmentMap({ width, height, pixels });
renderer.setEnvironment({ intensity: 1.5, rotation: Math.PI / 2 }); // radians
console.log(renderer.environmentSettings);
```

Await environment and scene replacements sequentially. Dimensions must fit the device, and pixels must be finite, nonnegative, and within float16's maximum of 65504. Intensity must be finite and nonnegative; rotation must be finite. This is one distant environment, with no local reflection probes, parallax correction, skybox, or `.hdr`/EXR file decoder. The fixed resolution/sample count favors a small teaching renderer; tiny bright sources can alias, low-resolution cube seams may remain, and the specular filter does not use solid-angle source mip selection. The existing ambient floor is retained for compatibility rather than claiming full physical calibration.

### Instance and order draws

Scene shaders write linear radiance to a viewport-sized `rgba16float` attachment. Opaque, masked, and blended geometry all use this target; transparent RGB blends in linear space while alpha remains linear. Values above one survive until presentation. After the scene pass ends, `OutputPass.encode()` draws one fullscreen triangle into the canvas. It applies exposure as `2^EV`, then the selected tone curve, then sRGB display encoding. Reinhard uses `color / (1 + color)` per channel, compressing highlights smoothly. None skips the curve for debugging. The preferred unorm canvas receives explicit sRGB encoding; an sRGB attachment instead uses hardware encoding to avoid a double transfer function.

`OutputPass` owns its resolved HDR texture, optional multisampled HDR attachment, views, bind group, and 16-byte settings uniform. Resize recreates the viewport attachments and bind group together; renderer disposal releases the targets and uniform. The presentation pipeline is compiled once, and exposure/curve changes update only uniform data. The resolved target uses eight bytes per pixel; MSAA adds four HDR samples and matching multisampled depth storage, and presentation adds a fullscreen pass. This is an HDR intermediate with SDR presentation, not HDR display output. Reinhard is a simple per-channel curve, not an ACES color-management pipeline; no bloom, automatic exposure, or gamut mapping is included.

Programmatic callers can use `renderer.setOutput({ exposureEV: 1, toneMapping: 'reinhard' })` and read `renderer.outputSettings`. Exposure accepts finite values from −16 to +16 EV; the UI offers a smaller practical range. Settings are validated before state changes. Tone mapping is applied consistently to lit materials, unlit materials, and the background after scene compositing.

### Resolve antialiasing in linear HDR

The renderer defaults to four-sample multisample antialiasing (MSAA). In accordance with [WebGPU's multisample state and attachment rules](https://gpuweb.github.io/gpuweb/#dictdef-gpumultisamplestate), scene pipelines, the `rgba16float` color attachment, and `depth24plus` depth attachment all use the same sample count. The color attachment's `resolveTarget` is the existing single-sampled HDR texture. At scene-pass end, WebGPU averages the samples into that target. Tone mapping and sRGB encoding then run once per resolved pixel through the existing single-sampled fullscreen pass. Averaging after a nonlinear curve would produce a different edge color, so resolve must precede presentation.

`OutputPass.sceneAttachment(clearValue)` supplies a consistent render-pass descriptor for either mode. In four-sample mode it clears the multisampled attachment, resolves into HDR, and discards temporary color samples at pass end; in single-sample mode it renders directly into HDR and stores it. Opaque, masked, and transparent draws share the attachment. Transparency blends per covered sample in linear space before resolve. Alpha-to-coverage remains disabled: glTF MASK still uses its cutoff/discard and BLEND retains authored alpha blending. Material layouts, neutral defaults, color-space decoding, and shader variants are unchanged. Pose upload and deformation compute finish before the scene pass as before; resolving adds no CPU wait, separate compute dispatch, or presentation draw.

Sample count is fixed at renderer creation, so changing models or resizing never creates sample-count mismatches. To disable MSAA for reduced memory cost or comparisons:

```ts
const renderer = await Renderer.create(canvas, onError, { sampleCount: 1 });
// Omit options (or pass sampleCount: 4) to enable 4× MSAA.
console.log(renderer.sampleCount);
```

Only 1 and 4 are accepted, including validation for JavaScript callers. `OutputPass.create(device, format, sampleCount)` also accepts either count; its standalone default remains one for existing consumers. The renderer passes its selected count explicitly into both output storage and `PipelineCache`.

MSAA improves geometric coverage, including silhouettes and depth intersections, but does not solve shader/specular aliasing or texture alpha-cutout aliasing. Mipmaps and anisotropic filtering continue to handle texture minification. No temporal history, TAA, or FXAA is introduced. The nominal color storage becomes 40 bytes per viewport pixel (32 for multisampled HDR plus 8 for resolved HDR), versus 8 without MSAA, and depth also stores four samples; actual allocation and render costs depend on the GPU. Resolution/device-pixel-ratio limits still apply. Both HDR attachments and depth are recreated on resize and released on disposal.

The selected scene's initial parent transforms are accumulated once. Each instance stores a world matrix and its inverse transpose as two mat4 values (128 bytes, matching WGSL storage alignment). Primitive instance ranges are packed into one scene storage buffer, bound once, and addressed with `instance_index` and `firstInstance`. Static nodes referencing the same opaque primitive are drawn together. Transform records are duplicated for each primitive of a multi-primitive mesh; this keeps ranges contiguous and avoids another indirection in this teaching renderer. Static data is never uploaded again each frame.

Scenes with clips use individual node draws, and skinned/morphed nodes always own their deformation streams. This preserves independent poses and morph weights when multiple nodes share a mesh. Original UV/color bufferViews and index buffers remain shared. Both winding pipelines are prepared at load time for pose-dependent draws, allowing animated scales to cross zero and become negative without creating pipelines during playback. The active draw is submitted only in its current winding group. Transparent draw centers are updated with the pose before sorting.

Opaque draws are grouped **pipeline → material → primitive**, reducing pipeline and material bind changes. Negative-determinant transforms use a separate winding pipeline and instance batch. Blended draws disable depth writes and are submitted after opaque geometry, back to front by transformed primitive center along the camera direction. Transparent instances deliberately use individual draws, since their ordering changes with the camera. Center sorting cannot correctly resolve intersecting triangles or every concave transparent mesh; order-independent transparency is outside this renderer's scope.

### Make ownership explicit

Every scene owns its buffers and textures through `Resources`. A replacement is prepared before the current scene is destroyed; failed loads destroy their temporary allocations. ImageBitmaps are closed after upload, depth textures are recreated on canvas-size changes, and `Renderer.destroy()` cancels animation, removes camera listeners, releases allocations, and destroys the device. Device loss and uncaptured GPU errors stop rendering and display a message. Loading is serialized in the UI; callers using the renderer directly should also await each `setAsset()` call.

## Supported behavior and limits

- glTF JSON and GLB 2.0, relative/data URI buffers and images, and embedded GLB images.
- Selected/default scene, hierarchy, matrix or TRS transforms, repeated mesh instancing, and inverse-transpose normals for nonuniform scales.
- Indexed/non-indexed points, lines, line strips/loops, triangles, triangle strips/fans. Missing normals give useful flat shading for triangles; supply normals or an unlit material for points/lines.
- Float POSITION/NORMAL/UV/COLOR/TANGENT plus decoded normalized integer UV/color attributes and sparse accessors. TEXCOORD_n sets are available per texture; only COLOR_0 is consumed.
- All five core material textures: base color, emissive, metallic/roughness, normal (with scale), and occlusion (with strength). Material factors, vertex colors, OPAQUE/MASK/BLEND, double-sided materials, and KHR_materials_unlit are supported.
- JPEG/PNG browser-decoded images, KHR_texture_transform, wrap/filter sampler translation, GPU mipmap generation, and linear-light shading with sRGB decoding for color maps and linear sampling for data maps.

This is **not a complete glTF conformance implementation or a full PBR viewer**. Lighting uses a GGX-style direct light, a small ambient term, and diffuse/specular environment lighting. Four-sample MSAA smooths geometric edges. It has no shadows or frustum culling. Center-based transparency sorting remains approximate even with correct linear blending.

Authored glTF cameras/lights are ignored in favor of orbit controls and the viewer light. Unsupported required extensions (including Draco, meshopt, KTX2, and quantization) are rejected. Optional extensions are not applied except KHR_materials_unlit and KHR_texture_transform. The parser performs targeted integrity checks but is not a substitute for the Khronos glTF Validator. Normal mapping is intended for triangles; supply unlit materials for points/lines without meaningful surface normals.

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

The frame loop keeps three explicit boundaries: `uploadPose(scene)` updates joint palettes, morph weights, instance transforms, winding, and sorting centers; `encodeDeformation(encoder, scene, poseChanged)` dispatches compute and ends its pass; `encodeRender(encoder, scene)` draws from the prepared output into HDR storage. Presentation follows scene rendering, and submission happens once after all encoding phases. The pose-change flag belongs to the current frame, so paused frames skip uploads and compute while continuing to render camera and display changes. When adding deformation features, place new pose inputs in the upload phase and kernels in the compute phase; keep uploads and deformation dispatches out of render-pass encoding.

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

Color-space regressions compare base-color and emissive maps against equivalent linear factors. `tests/material-slots.test.ts` verifies the neutral defaults and color-space contract, plus identical material declarations across 60 combinations of vertex inputs and UV-set availability. UV browser fixtures compare all five slots against baked coordinates, including extension overrides and transformed normal-map bases; missing selected sets retain the current model.

`tests/texture-coordinates.test.ts` checks affine-transform order, defaults, malformed values, sparse normalized UV sets, compact UV locations, mip counts, and all six minification modes. `browser-tests/mipmaps.spec.ts` reads GPU-generated mip levels back to verify linear-light color filtering, linear data/alpha, and NPOT/thin images. The optional live ChronographWatch GLB regression verifies texture-transform loading and saves a screenshot alongside the other public-model tests.

Sampler tests also check anisotropy eligibility, explicit quality requests, and preservation of nearest/non-mip modes. A browser regression creates every glTF minification/magnification combination on the real GPU to verify the anisotropic descriptors satisfy WebGPU validation.

`browser-tests/output.spec.ts` blends an HDR foreground over a known background on the GPU, then compares readback pixels against linear blending, exposure, Reinhard, and sRGB equations. Both unorm and sRGB presentation formats are tested, including highlight recovery with reduced exposure, invalid exposure requests, and resizing. Viewer tests check display controls without scene pipeline changes. Texture channel regressions explicitly select None at zero exposure to isolate material math from the nonlinear tone curve.

`browser-tests/antialiasing.spec.ts` renders a slanted translucent HDR triangle in one- and four-sample modes, then checks every presented pixel against the expected coverage → linear blend → resolve → Reinhard → sRGB equations. Only MSAA may produce fractional edge coverage; averaging tone-mapped samples would fail the color checks. It also validates resize, invalid sample counts, explicit single-sample renderer operation, default four-sample operation, and model replacement without GPU errors. Existing animation, material, environment, and public-model tests now run with the viewer's default MSAA.

`tests/environment.test.ts` validates the procedural HDR source and malformed radiance inputs. `browser-tests/environment.spec.ts` reads GPU-filtered maps to check constant HDR radiance across every face/mip, cube orientation, roughness broadening, finite BRDF coefficients, sRGB panorama decoding, and preservation after invalid replacement. Viewer checks cover intensity, yaw, metallic reflections, unlit stability, local panorama loading, failed-image recovery, and Studio reset without changing scene pipeline counts. Existing channel-math regressions disable environment intensity to isolate their original direct/ambient equations.

The DamagedHelmet regression loads the public Khronos GLB with all five material textures and requires network access. It is skipped by default.

`tests/animation.test.ts` also covers key clamping, STEP boundaries, cubic tangent timing, normalized and shortest-path rotations, clip resets, morph-before-skin ordering, inverse binds, independent node weights, sparse targets, multiple influence sets, and malformed inputs. `browser-tests/animation.spec.ts` verifies rendered changes during node motion, skinning, and morph playback, paused-frame stability, scrubbing, and authored-pose restoration. Optional network tests load Khronos SimpleSkin and AnimatedMorphCube. Set TEST_REMOTE_MODELS as below to include these public-asset regressions.

`browser-tests/compute.spec.ts` dispatches the production kernel on the real GPU and reads output back only for testing. It compares positions, normals, and tangents against the CPU oracle for skin-only, morph-only, combined, sparse, multiple-influence, reflected/nonuniform, and singular cases. Its 69-vertex fixtures exercise partial workgroups, and repeated dispatches change weights and joint matrices to detect accumulation and stale uploads.

`tests/animation-controller.test.ts` verifies frame-time conversion and looping, pause/resume without time jumps, paused seeks, authored-pose restoration, scene replacement, static-pose reuse, notifications, and invalid playback requests without requiring a GPU or browser.

```powershell
$env:TEST_REMOTE_MODELS = '1'
npm run test:browser
Remove-Item Env:TEST_REMOTE_MODELS
```

Test your own textured and transparent assets before depending on broader feature coverage.
