# WebGPU glTF renderer

A small, commented TypeScript renderer for glTF 2.0 scenes, built directly on WebGPU. It supports static scenes, animation clips, linear blend skinning, and morph targets. It includes a browser viewer, an offline demo, and tests for the parts where glTF's data layout does not map directly to WebGPU.

The architecture follows [Toji's “Efficiently rendering glTF models” case study](https://toji.dev/webgpu-gltf-case-study/). It is an independent implementation, not a copy of the sample renderer. As in the article, the focus is efficient data preparation and draw submission rather than full glTF feature coverage.

## Run

Use Node.js 22.12+ (Node.js 24 recommended) and a browser/device with WebGPU enabled.

```sh
pnpm install --frozen-lockfile
npm run dev
```

Open the localhost URL printed by Vite. WebGPU needs a secure context: localhost works for development; deployment needs HTTPS. If no GPU adapter is available, the viewer displays an error instead of silently falling back to another renderer.

```sh
npm test          # CPU-side glTF and layout regression tests
npm run build    # Strict TypeScript check and production bundle
npm run preview  # Serve the production bundle locally
npm run test:browser # Real WebGPU integration tests in installed Microsoft Edge
npm run test:compressed-build # After build: verify emitted Draco/Basis WASM and worker URLs
```

The first scene is generated locally and makes no network requests for models. Three green cubes share one primitive, so they render in one instanced draw; the orange cube shares the pipeline but uses a different material. The demo reports **1 pipeline, 2 draws, and 4 primitive instances**. These counts describe scene geometry; the fixed fullscreen presentation pipeline and draw are additional.

Use **Open model** to select one `.glb`, or one `.gltf` together with its binary and image dependencies. Local dependencies are matched by decoded URI or filename; assets with different dependencies sharing the same filename should be served by URL instead. **Load URL** accepts a model URL and resolves dependencies relative to it. Cross-origin servers must enable CORS. Drag to orbit, scroll to zoom, and use **Reset camera** to return to the fitted view.

Models with animation clips show a clip selector, Play/Pause, Restart, and a timeline. The first clip plays automatically and loops over its duration. Scrubbing pauses playback; selecting **Authored pose** restores the original TRS and morph weights. While playing, selecting a clip crossfades over the **Fade (s)** duration (default 0.3 seconds); set it to zero for immediate switching. Paused selection and **Authored pose** switch immediately. Pause also freezes an active fade, and scrubbing or Restart ends it at the destination clip. Models with skinning or morph weights also render correctly without an animation clip.

Display controls select **Reinhard** tone mapping (default) or **None**, and adjust exposure from −6 to +6 EV. One extra EV doubles linear brightness; negative exposure reveals highlight detail. None retains the HDR rendering path but clips display values above one after exposure. Display settings persist across model replacements and do not rebuild scene pipelines.

The viewer enables **4× MSAA** by default to smooth geometry silhouettes and intersections. Color and depth use four samples per pixel; the scene resolves into linear HDR before exposure and tone mapping. Antialiasing persists across model and environment replacements.

Authored directional, point and spot lights load automatically. **Shadows** toggles filtered shadow maps and persists across model replacements. Models without selected-scene light instances retain the viewer's directional light, which also casts shadows.

Environment lighting starts with an original, generated HDR **Studio** panorama. **Open environment** accepts an equirectangular Radiance **HDR (.hdr/.pic)** or PNG/JPEG panorama (typically 2:1, longitude across X and north pole at the top). Adjust **Intensity** or rotate it around the vertical axis with **Rotation**. Studio restores the default map. Map and lighting settings persist across model loads; failed environment loads retain the current lighting. Environment intensity zero disables its contribution while retaining the existing directional light and small ambient term.

## Code map

The project separates asset decoding (`gltf`), CPU pose/animation (`scene` and `animation`), gameplay worlds (`engine`), WebGPU rendering (`renderer`), and browser UI (`app`). See [Architecture and maintenance](docs/architecture.md) for dependency rules, resource ownership, frame phases, and extension points.

See the [October 2026 code review](docs/review.md) for verified fixes, test results, remaining feature gaps, and a prioritized maintenance plan. Scene and environment GPU preparation now share a device-scoped transaction queue; overlapping public API calls validate and commit in order while failed candidates release their allocations. Core material factors are validated before texture preparation.

| Module or directory                                                 | Responsibility                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/index.ts`, `src/renderer/index.ts`                             | Public rendering, settings, statistics, animation and loading exports             |
| `src/main.ts`                                                       | Viewer bootstrap                                                                  |
| `src/app/viewer.ts`, `src/app/dom.ts`                               | Application state, serialized loading, status and shared DOM helpers              |
| `src/app/render-loop.ts`                                            | Viewer-owned browser scheduling adapter, cancellation and frame failure handling  |
| `src/app/controls/`                                                 | Separate animation, environment and display widgets                               |
| `src/app/demo.ts`, `src/app/style.css`                              | Offline demo and viewer presentation                                              |
| `src/gltf/types.ts`, `src/gltf/loader.ts`                           | Typed glTF subset, JSON/GLB parsing, URI resolution and image loading             |
| `src/gltf/compression/`, `src/gltf/quantization.ts`                 | meshopt/Draco decoding, Basis KTX2 transcoding, quantized attribute support       |
| `src/gltf/accessors.ts`, `src/gltf/geometry.ts`                     | Accessor decoding, canonical layouts, repacking and topology conversion           |
| `src/gltf/scene.ts`, `src/gltf/texture-coordinates.ts`              | Initial scene traversal and per-slot UV selection/transforms                      |
| `src/animation/tracks.ts`, `blending.ts`, `controller.ts`           | Track interpolation, local-pose mixing and independent playback policy            |
| `src/scene/pose.ts`                                                 | Reusable node poses, hierarchy evaluation and revision tracking                   |
| `src/scene/deformation-inputs.ts`, `src/scene/deformation.ts`       | Shared decoded inputs, joint palettes, bounds and CPU deformation oracle          |
| `src/renderer/renderer.ts`                                          | Public facade, device lifecycle, scene replacement and frame coordination         |
| `src/renderer/core/`                                                | Resource ownership, explicit binding layouts/record sizes and viewport resizing   |
| `src/renderer/scene/builder.ts`                                     | Load-time materials, geometry, pipelines and draw records                         |
| `src/renderer/scene/geometry-uploader.ts`                           | Scene-scoped vertex-view and index upload caches                                  |
| `src/renderer/scene/pose-upload.ts`                                 | Selective pose uploads, winding, bounds and sorting centers                       |
| `src/renderer/scene/types.ts`                                       | Prepared draw/scene records and statistics                                        |
| `src/renderer/scene/frustum.ts`, `src/renderer/scene/visibility.ts` | Clip planes, affine bounds and visible instance runs                              |
| `src/renderer/deformation/`                                         | Shared compute inputs, batch arenas/jobs, kernels and compute pass                |
| `src/renderer/materials/`                                           | Material factory, validated uniforms, fixed texture slots and extension lighting  |
| `src/renderer/textures/`                                            | GPU mipmaps and sampler/anisotropy policy                                         |
| `src/renderer/render/`                                              | Pipeline cache, generated WGSL and draw submission                                |
| `src/scene/lights.ts`, `src/renderer/lighting/`                     | Authored light poses, shadow maps, HDR environment filtering and lighting shaders |
| `src/renderer/presentation/output.ts`                               | HDR/MSAA targets, linear resolve, exposure, tone mapping and presentation         |
| `src/renderer/camera/orbit-camera.ts`                               | Orbit controls, framing and WebGPU depth projection                               |

The existing settings and playback APIs remain available. `Renderer.create()` now prepares an idle renderer; callers explicitly submit frames with `render(timestampMs)`. The viewer retains continuous rendering through its scheduling adapter. Internal feature modules live in the directories above; imports of those implementation files should use their new paths.

## Explicit frames and engine integration

Creating a renderer and loading an asset do not start a frame loop. The caller controls when a frame happens and supplies a finite timestamp in **milliseconds**, using a consistent, nondecreasing clock. Browser RAF timestamps work; engines may supply their own simulation clock. This lets gameplay and physics finish before rendering preparation begins.

```ts
import { Renderer, loadUrl } from './src';

const renderer = await Renderer.create(canvas, showError);
await renderer.setAsset(await loadUrl(modelUrl));
renderer.render(0); // One frame; the caller schedules any later frames.
```

Inside an engine's existing frame callback, the order can be:

```ts
function frame(timestampMs: number) {
  gameplay.update(); // Engine-owned simulation policy and timestep.
  physics.step();
  if (!renderer.render(timestampMs)) engine.stop();
}
```

`render()` synchronously prepares/uploads the current pose and camera, records compute, shadows, scene and presentation, and submits once. It returns `true` after submission, without waiting for GPU completion. Animation is evaluated inside this preparation using the supplied clock; do not also call `renderer.animation.update()` separately. A nonfinite timestamp throws without disabling the renderer. Frame/GPU/device failures invoke `showError` once and disable further frames; `render()` then returns `false`. Calls after `destroy()` also return `false`. Cancel the owner's loop before destroying the renderer; destruction is idempotent.

The browser viewer uses `ViewerRenderLoop` in `src/app/render-loop.ts`. Its `start()` schedules one RAF chain, `stop()` cancels pending work, and `destroy()` permanently disables scheduling. Generation checks ignore cancelled callbacks arriving after stop/restart. The adapter owns scheduling only; `Viewer` stops it on fatal errors and destroys it before the renderer on page exit. Playback controls, camera movement, resize, model/environment loading and rendering while animation is paused retain their existing viewer behavior. Engines can call the public frame method directly without importing viewer code.

**Migration:** embedding applications that previously relied on automatic frames from `Renderer.create()` must call `render()` from their own loop. Browser tests and benchmarks now use that public method rather than private render/stop hooks.

See [frame scheduling and lifecycle](docs/frame-scheduling.md) for ownership rules and regression coverage.

## Gameplay transforms

Gameplay owns entity roots by default. Explicitly hand authority to physics with `entity.setTransformOwner('physics')`, then write `entity.setTransform(patch, 'physics')`; conflicting gameplay writes reject. Animation owns model node locals. Use `entity.model.setNodeOverride(node, patch)` for deliberate per-field exceptions, inspect them with `getNodeOverride()`, and release fields with `clearNodeOverride(node, fields?)`. Existing node-transform setters retain their override behavior. `clearNodeTransform(node)` resumes animation. Getters return copies, setters validate inputs, and revisions update uploads, winding, bounds, shadows and occlusion dependencies.

For a single asset, declare movable subtrees with `await renderer.setAsset(asset, { movableNodes: [node] })`, then use `renderer.setNodeTransform(node, patch)`. Undeclared nodes reject edits; unrelated static instances stay grouped. World models are already prepared for gameplay movement. See [supported transform APIs](docs/transforms.md) for animation precedence, validation, revision tracking and matrix-node limitations.

## Game entities and model instances

`World` stores gameplay entities identified by strings. An entity may instantiate one glTF model containing many mesh, joint and light nodes; those node indices stay local to that `ModelInstance`. Entity hierarchy, placement and component data remain outside glTF. Multiple entities can reference one loaded `Asset`, while each instance owns its pose and animation controller. Selecting an authored pose or crossfading changes model locals without resetting entity placement.

```ts
import { World, ModelLibrary, Renderer, loadUrl } from './src';

const renderer = await Renderer.create(canvas, showError);
const models = new ModelLibrary();
models.register(
  'hero',
  await loadUrl('models/hero.glb', {
    textureCompression: renderer.textureCompression,
  }),
  'models/hero.glb',
);

const world = new World(models);
const player = world.createEntity({
  id: 'player',
  model: { asset: 'hero' },
  transform: { translation: [0, 0, 0] },
  components: { health: { current: 100, max: 100 } },
});
world.createEntity({ id: 'npc', model: { asset: 'hero' }, transform: { translation: [3, 0, 0] } });
await renderer.setWorld(world);

// Gameplay/physics writes placement before the caller-owned render frame.
player.setTransform({ translation: [1, 0, 0] });
player.model!.animation.select(0); // Independent of the NPC's playback.
renderer.render(0);

const savedScene = JSON.stringify(world.toDocument(), null, 2);
```

Engine scene JSON has `version: 1`, an `assets` dictionary mapping stable IDs to model URIs, and `entities` containing IDs, optional parents/names, transforms, model references and JSON component data. `parseSceneDocument()` validates it; `loadWorld(document, resolver?)` loads each asset ID once and builds independent model instances. Component data is preserved for gameplay systems; it does not automatically implement physics or behaviors. Scene saving does not embed glTF nodes, geometry, GPU resources or current animation playback state.

`setTransform()` and `world.setParent()` become visible on the next frame without GPU preparation. Creating or destroying entities changes membership: pause submission, mutate the world, await `renderer.setWorld(world)`, then resume. Rendering an uncommitted membership change throws a recoverable error instead of drawing stale entities. A failed replacement releases candidate resources and retains the previously attached scene. Empty worlds render the background. The original viewer and `setAsset()` remain available.

Loaded resources are separate from instances: `ModelLibrary.getModel(id)` returns a CPU `LoadedModel` shared through `ModelInstance.resources`, including lazily prepared, frozen animation clips. Entities using the same `Asset` share GPU geometry, textures, material bindings, pipelines and immutable deformation inputs. Poses, animation, joint palettes, morph weights and deformation outputs remain independent. Shared allocations survive overlapping scene replacement and release after their final scene lease. See [shared model resources](docs/model-resources.md). All world model nodes are treated as movable so entity placement reaches transforms, joint palettes, bounds, winding, lights, shadows and occlusion dependencies. See [entity ownership and the scene format](docs/game-world.md) for loading, hierarchy, lifecycle and test coverage.

## How the case study informs the implementation

### Do work when loading, not when drawing

The loader resolves bytes and images first. `SceneBuilder.prepare()` traverses the scene and prepares geometry, transforms, materials, bind groups, and pipelines before displaying it. Static frames update the camera uniform, test instance visibility, optionally upload occlusion proxies, sort transmitting draws (and ordinary transparent draws in sorted mode), and submit prepared draw records. Animated frames have a separate pose/deformation update before draw submission. Accessors and tracks are decoded at load time; playback reuses GPU allocations and pipelines, with viewport attachments recreated on resize and optional query buffers growing to their bounded capacity when needed.

### Normalize vertex offsets and preserve interleaving

For float attributes, the renderer uploads each referenced bufferView once. Attributes sharing the same bufferView, stride, and record base share a binding. A large accessor offset is split into a buffer binding base and a small within-record offset. Only the latter enters `GPUVertexAttribute.offset`; the base is passed to `setVertexBuffer()`. Separate planar ranges remain separate bindings even when they share a bufferView.

Attributes use fixed shader locations and are sorted before buffers are ordered. Pipeline keys therefore do not depend on JSON property order or buffer IDs. Sparse and integer attributes are repacked as floats because WebGPU does not directly support every glTF vertex format (notably packed integer VEC3s). This trades load-time work and some memory for simpler shader interfaces. POSITION accepts float VEC3 or the integer formats declared by KHR_mesh_quantization; normalized values are decoded before bounds and GPU deformation inputs are prepared.

All GPU buffer allocations are rounded up to four bytes. Initial uploads use mapped buffers so byte-sized source data and odd uint16 index counts do not need padded source arrays. Byte indices are promoted to uint16; index streams containing values reserved for uint16 strip restart use uint32. Line loops and triangle fans become indexed lists during preparation.

### Cache immutable state

`PipelineCache` keys contain canonical vertex layouts, topology, strip index format, available shader inputs, blending, culling, and winding. Uniform values, texture identities, absolute buffer offsets, and node IDs are excluded. Color target format, depth format, sample count, and bind group layouts are fixed for a renderer and do not need redundant key fields. Pipeline creation is asynchronous and finishes before the scene is swapped in.

Shaders vary only when NORMAL, available TEXCOORD sets, COLOR_0, or TANGENT inputs differ. Alpha cutoff, normal-map presence, UV-set selection, texture transforms, and unlit behavior are uniform-driven. Untextured primitives may omit UVs; every actual texture must reference an available coordinate set. Missing colors use white. Missing normals use fragment derivatives for flat triangle lighting. Every material has the same bind group layout with all five core glTF texture slots plus seven extension slots. Neutral one-pixel textures supply defaults without extra pipeline variants. A new scene receives a fresh cache so loading many unrelated assets cannot grow the pipeline cache indefinitely.

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

`renderer/materials/slots.ts` is the single source of truth for the twelve texture slots. The explicit GPU layout, every material bind group, and all WGSL variants use its binding numbers. Texture presence never changes the interface or adds a pipeline variant. Neutral textures are cached by format and RGBA value, so color and data defaults share allocations only when their formats match. Base-color and emissive RGB decode through `rgba8unorm-srgb`; alpha remains linear. Metallic/roughness, normal, and occlusion use `rgba8unorm`. Missing emissive maps use white to preserve factor-only emission; the default emissive factor is zero. Missing normal maps also bypass perturbation, avoiding the small XY quantization offset in the neutral 8-bit normal texture.

Authored VEC4 tangents use XYZ for the tangent and W for bitangent handedness. Tangents transform with the world matrix, while normals use the inverse transpose; the shader orthogonalizes the tangent against the interpolated normal. Negative-determinant node transforms also reverse tangent handedness. When tangents are absent, the shader reconstructs a triangle-local basis from position/UV derivatives. Degenerate UVs retain the surface normal. If normals are absent, authored tangents are ignored and the derivative basis uses flat normals. All samples and derivatives run before alpha-mask discard. Back faces reverse the complete mapped normal before lighting.

The derivative fallback is useful for assets such as DamagedHelmet, but is not MikkTSpace tangent generation and may differ at seams from the basis used when baking the map. Export authored tangents for the closest match. No normal-map-specific pipeline variant is needed: a material uniform controls its use.

### Select UV coordinates and generate mipmaps

Each of the twelve texture slots independently selects `textureInfo.texCoord`, defaulting to zero. [KHR_texture_transform](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_transform/README.md) can override that selection and supplies offset, rotation in radians, and scale. The shader applies `offset + rotation * (scale * uv)` before sampling. The extension works both when optional and when listed in `extensionsRequired`. Missing selected UV sets are reported with the slot name and required TEXCOORD semantic, preserving the current scene if replacement fails.

Geometry binds available `TEXCOORD_n` sets in a deterministic order, including normalized integer and sparse accessors. Additional sets receive compact shader locations, so semantic numbering need not be consecutive. Vertex and inter-stage limits still depend on the GPU; this is not unlimited UV storage. Each material uniform contains eight factor vec4s (128 bytes) plus twelve pairs of vec4 transform rows (32 bytes per slot), for 512 bytes total. Binding numbers and texture defaults are unchanged across variants. The normal slot uses authored tangents only for TEXCOORD_0 with an unchanged linear UV basis; alternate sets, UV rotation, or scale use derivatives of the normal slot's transformed coordinates. Offset alone preserves the authored tangent basis. Degenerate UV transforms retain the geometric normal.

Image uploads allocate a complete mip chain, including non-power-of-two and one-pixel-wide/tall images. `MipmapGenerator` renders each lower level from a view of the preceding level during scene preparation. Color textures use sRGB views: sampling decodes to linear light, filtering averages there, and the sRGB attachment encodes the result. Data textures remain unorm throughout; alpha remains linear in both cases. The generator caches pipelines per format/filter policy and mipmaps belong to the scene's texture allocation. No mip generation occurs in the playback pose-upload, compute, or render phases.

All six glTF minification filters map to their corresponding in-level and mip filtering modes. NEAREST/LINEAR without mipmaps clamp sampling to level zero; the four mip filters can select the full chain. An omitted minification filter uses linear filtering with linear mip interpolation. Neutral 1×1 defaults need no generation. Mipmaps add roughly one-third texture memory for large square images. Generated mipmaps use the area and alpha filtering policies below. Alpha-mask coverage preservation and roughness adjustment for normal-map variance are not implemented.

Anisotropic filtering requests up to **16×** for samplers with linear magnification and LINEAR_MIPMAP_LINEAR minification, including the renderer's default sampler. This improves texture detail at oblique viewing angles. [WebGPU requires all three filtering modes to be linear](https://gpuweb.github.io/gpuweb/#dom-gpusamplerdescriptor-maxanisotropy) when anisotropy exceeds one, so authored nearest filtering, nearest mip selection, and non-mip modes retain `maxAnisotropy: 1`. No glTF filter mode is silently overridden. The platform clamps the request to its supported maximum; visual results and cost vary by GPU. `samplerDescriptor(definition, requestedAnisotropy)` accepts integers from 1 to 16, with one disabling the enhancement. Material samplers use the default request of 16; the mip-generation sampler itself remains ordinary bilinear filtering.

### Prepare environment lighting once

`EnvironmentLighting` supplies image-based lighting (IBL) using the split-sum approach described in [Filament's image-based lighting documentation](https://google.github.io/filament/main/filament.html#lighting/imagebasedlights). A panorama is converted into a **16×16 diffuse irradiance cubemap**, a **64×64 specular cubemap with seven roughness mips**, and a **64×64 BRDF integration LUT**. The GPU compute shader uses 128 Hammersley samples per filtered texel: cosine-weighted hemisphere samples store diffuse irradiance divided by π; GGX half-vector importance samples filter specular radiance. Specular level zero samples the panorama directly. Roughness increases linearly from zero to one across levels, so shading selects `roughness * 6`. The BRDF LUT stores the scale/bias terms indexed by N·V and roughness and is generated once per renderer.

Panorama pixels are linear floating-point radiance. PNG/JPEG input converts browser-decoded sRGB RGB to linear once; these formats supply LDR lighting. Radiance RGBE files, the generated studio map, and API-supplied arrays preserve values above one without sRGB conversion or tone mapping during loading. An `rgba32float` panorama uses explicit bilinear `textureLoad` interpolation, wrapping longitude and clamping latitude, avoiding a dependency on optional float32 filtering support. All filtered resources use `rgba16float`. Each dispatch has its own parameter buffer so queued jobs do not accidentally share the final job's parameters. Temporary source textures and buffers are released after GPU preparation completes.

All scene shader variants use one explicit environment bind group at **group 3**: filtering sampler, diffuse cube, specular cube, BRDF LUT, and a 16-byte intensity/rotation/maximum-LOD uniform. The five material texture slots remain unchanged at group 2, including their neutral defaults and color-space rules. Intensity and yaw updates write only uniform data; replacing a panorama reuses the same layout and scene pipelines. Replacement maps are prepared before their bind group is swapped; failure releases candidate resources and preserves the previous map. Renderer disposal releases lighting textures and uniforms.

Radiance loading is implemented in `src/renderer/lighting/radiance.ts`, following the [Radiance picture format reference](https://radsite.lbl.gov/radiance/refer/Notes/picture_format.html). It supports `FORMAT=32-bit_rle_rgbe`, modern per-channel scanline RLE, flat RGBE pixels, and legacy repeated-pixel runs. Resolution signs and X/Y-major ordering normalize into top-left equirectangular RGBA pixels. LF/CRLF headers are accepted. RGBE mantissas share a biased exponent; decoding multiplies RGB by `2^(E - 136)`, with exponent zero producing black and alpha set to one. Stored linear radiance is used as-is; `EXPOSURE`, `GAMMA`, and other optional metadata do not apply extra corrections or color-space conversion. Inputs are assumed to use the renderer’s linear RGB primaries.

The loader detects the Radiance signature for nameless `Blob`s, as well as `.hdr`/`.pic` filenames and HDR MIME types. The CPU decoder rejects malformed/truncated runs, invalid sizes, and unsupported XYZE files. Its limits are a 64 KiB header, 32M decoded pixels (including 8K × 4K panoramas), and 32768 per dimension; upload also enforces the device’s texture dimension limit. RGB radiance above **65504** is rejected to retain the existing float16 filtering/render-target contract; reduce the source radiance before loading such a file. OpenEXR is not supported. A failed load preserves the current environment and controls remain usable.

```ts
import { loadEnvironmentImage, decodeRadiance } from './src/index';

// Local File or fetched Blob; HDR stays linear, PNG/JPEG converts from sRGB.
const image = await loadEnvironmentImage(file);
await renderer.setEnvironmentMap(image);

// For callers already holding Radiance file bytes:
const hdr = decodeRadiance(new Uint8Array(arrayBuffer));
await renderer.setEnvironmentMap(hdr);
```

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

Scene shaders write linear radiance to a viewport-sized `rgba16float` attachment. Opaque and masked geometry use this target directly; sorted transparency blends there, while weighted transparency composites its separate accumulation buffers into the same linear HDR target. Alpha remains linear. Values above one survive until presentation. After the scene pass ends, `OutputPass.encode()` draws one fullscreen triangle into the canvas. It applies exposure as `2^EV`, then the selected tone curve, then sRGB display encoding. Reinhard uses `color / (1 + color)` per channel, compressing highlights smoothly. None skips the curve for debugging. The preferred unorm canvas receives explicit sRGB encoding; an sRGB attachment instead uses hardware encoding to avoid a double transfer function.

`OutputPass` owns its resolved HDR texture, optional multisampled HDR attachment, views, bind group, and 16-byte settings uniform. Resize recreates the viewport attachments and bind group together; renderer disposal releases the targets and uniform. The presentation pipeline is compiled once, and exposure/curve changes update only uniform data. The resolved target uses eight bytes per pixel; MSAA adds four HDR samples and matching multisampled depth storage, and presentation adds a fullscreen pass. This is an HDR intermediate with SDR presentation, not HDR display output. Reinhard is a simple per-channel curve, not an ACES color-management pipeline; no bloom, automatic exposure, or gamut mapping is included.

Programmatic callers can use `renderer.setOutput({ exposureEV: 1, toneMapping: 'reinhard' })` and read `renderer.outputSettings`. Exposure accepts finite values from −16 to +16 EV; the UI offers a smaller practical range. Settings are validated before state changes. Tone mapping is applied consistently to lit materials, unlit materials, and the background after scene compositing.

### Resolve antialiasing in linear HDR

The renderer defaults to four-sample multisample antialiasing (MSAA). In accordance with [WebGPU's multisample state and attachment rules](https://gpuweb.github.io/gpuweb/#dictdef-gpumultisamplestate), scene pipelines, the `rgba16float` color attachment, and `depth24plus` depth attachment all use the same sample count. The color attachment's `resolveTarget` is the existing single-sampled HDR texture. At scene-pass end, WebGPU averages the samples into that target. Tone mapping and sRGB encoding then run once per resolved pixel through the existing single-sampled fullscreen pass. Averaging after a nonlinear curve would produce a different edge color, so resolve must precede presentation.

`OutputPass.sceneAttachment(clearValue)` supplies a consistent render-pass descriptor for either mode. In four-sample mode it clears the multisampled attachment, resolves into HDR, and discards temporary color samples at pass end; in single-sample mode it renders directly into HDR and stores it. Opaque and masked draws establish the attachment. Sorted transparency blends directly; weighted transparency accumulates separately and composites per covered sample into it before the final resolve. Alpha-to-coverage remains disabled: glTF MASK uses cutoff/discard and BLEND uses authored alpha for coverage. Material layouts, neutral defaults, and color-space decoding are shared by both transparency modes. Pose upload and deformation compute finish before the scene pass as before; resolving adds no CPU wait, separate compute dispatch, or presentation draw.

Sample count is fixed at renderer creation, so changing models or resizing never creates sample-count mismatches. To disable MSAA for reduced memory cost or comparisons:

```ts
const renderer = await Renderer.create(canvas, onError, { sampleCount: 1 });
// Omit options (or pass sampleCount: 4) to enable 4× MSAA.
console.log(renderer.sampleCount);
```

Only 1 and 4 are accepted, including validation for JavaScript callers. `OutputPass.create(device, format, sampleCount)` also accepts either count; its standalone default remains one for existing consumers. The renderer passes its selected count explicitly into both output storage and `PipelineCache`.

MSAA improves geometric coverage, including silhouettes and depth intersections, but does not solve shader/specular aliasing or texture alpha-cutout aliasing. Mipmaps and anisotropic filtering continue to handle texture minification. No temporal history, TAA, or FXAA is introduced. The nominal color storage becomes 40 bytes per viewport pixel (32 for multisampled HDR plus 8 for resolved HDR), versus 8 without MSAA, and depth also stores four samples; actual allocation and render costs depend on the GPU. Resolution/device-pixel-ratio limits still apply. Both HDR attachments and depth are recreated on resize and released on disposal.

The selected scene's initial parent transforms are accumulated once. Each instance stores a world matrix and its inverse transpose as two mat4 values (128 bytes, matching WGSL storage alignment). Primitive instance ranges are packed into one scene storage buffer, bound once, and addressed with `instance_index` and `firstInstance`. Static nodes referencing the same opaque primitive are drawn together. Transform records are duplicated for each primitive of a multi-primitive mesh; this keeps ranges contiguous and avoids another indirection in this teaching renderer. Static data is never uploaded again each frame.

Scenes with clips use individual node draws, and skinned/morphed nodes always have independent deformation output ranges. This preserves independent poses and morph weights when multiple nodes share a mesh. Original UV/color bufferViews and index buffers remain shared. Both winding pipelines are prepared at load time for pose-dependent draws, allowing animated scales to cross zero and become negative without creating pipelines during playback. The active draw is submitted only in its current winding group. Transparent draw centers are updated with the pose before sorting.

Opaque draws are grouped **pipeline → material → primitive**, reducing pipeline and material bind changes. Negative-determinant transforms use a separate winding pipeline and instance batch. Blended draws disable depth writes and follow opaque geometry. Ordinary BLEND materials use weighted order-independent transparency by default; sorted mode retains back-to-front submission by transformed primitive center. Transparent instances retain individual draws for visibility and compatibility with sorted mode.

### Make ownership explicit

Every scene owns its buffers and textures through `Resources`. A replacement is prepared before the current scene is destroyed; failed loads destroy their temporary allocations. ImageBitmaps are closed after upload, depth textures are recreated on canvas-size changes, and `Renderer.destroy()` cancels animation, removes camera listeners, releases allocations, and destroys the device. Device loss and uncaptured GPU errors stop rendering and display a message. Loading is serialized in the UI; callers using the renderer directly should also await each `setAsset()` call.

### More reliable transparency

Ordinary glTF **BLEND** materials default to [weighted blended order-independent transparency](https://jcgt.org/published/0002/02/09/) (McGuire and Bavoil). It avoids primitive-center sorting for intersecting meshes, concave surfaces, and triangles inside a single primitive. Submission order does not determine the compositing formula, though float16 rounding can still cause small numeric differences.

`renderer/render/transparency.ts` owns two lazily allocated viewport attachments: `rgba16float` accumulation and `r16float` logarithmic transmittance. Color/alpha contributions accumulate additively, with positive bounded opacity/depth weights. The second attachment adds optical depth `-log(max(1 - alpha, 1e-8))`, retaining background coverage as `exp(-summedOpticalDepth)`. This is the same transmittance product as revealage multiplication, but avoids repeated half-float subtraction near one that can exaggerate low-opacity layers. Both attachments clear to zero. The composite divides accumulated color by accumulated alpha and applies coverage `1 - exp(-summedOpticalDepth)` over the HDR scene. A single layer reduces to ordinary OVER, within storage precision. Alpha-zero fragments contribute nothing. Opaque/MASK depth rejects hidden transparent fragments, and translucent fragments never write depth.

The shader scales accumulated RGB by `1/256` to leave headroom for bright HDR layers, then restores that scale during compositing. Weight is `clamp((alpha + 0.01)^3 * 8 * (1 - depth * 0.9)^3 * 1000, 1, 16)`. A weight floor of one reduces underflow of faint LDR contributions after RGB scaling. Radiance is bounded to the existing float16 range; accumulation overflow is saturated to keep presentation finite, losing accuracy for extreme bright stacks. Very small alpha values and deep stacks also encounter float16 precision limits. Weighted color is an approximation: high-opacity overlapping surfaces can mix colors rather than selecting the exact nearest layer. This does not implement per-pixel sorting, depth peeling, or an A-buffer.

In four-sample mode, both OIT attachments have four samples. Opaque/transmission HDR samples and depth are stored for continuation; a fullscreen composite reads accumulation/optical depth at `sample_index`, blends into the corresponding HDR sample, and only then resolves. Resolving OIT buffers before compositing would give incorrect colors when layers cover different samples. Exposure and tone mapping still occur once afterward. Allocations add nominally 10 bytes per viewport pixel per sample (40 at 4× MSAA), plus a fullscreen composite whenever visible BLEND draws exist. Buffers are reused across scene replacement, recreated on resize, and released on renderer destruction; scenes without ordinary transparency do not initially allocate them.

```ts
// Default: stable approximate compositing for ordinary BLEND materials.
const renderer = await Renderer.create(canvas, onError, { transparency: 'weighted' });

// Classic source-over, sorted by primitive center; useful for comparison or assets
// whose nearly opaque translucent layers need its different tradeoff.
const sorted = await Renderer.create(otherCanvas, onError, { transparency: 'sorted' });
console.log(renderer.transparencyMode);
```

The mode is fixed at creation because scene pipelines have different output attachments. Both retain the same explicit material layout, textures, sRGB/linear interpretation, deformation inputs, and culling. The low-level `PipelineCache`/`SceneBuilder` constructors retain sorted defaults for existing direct callers; pass the weighted mode explicitly when using them with `TransparencyPass`. Frame statistics count geometry submissions, excluding the OIT fullscreen composite.

Transmission materials remain on the sorted screen-space refraction path and render before ordinary transparency. Their opaque-only snapshot, depth-writing behavior for OPAQUE/MASK transmission, and limitations with nested glass or transparent geometry behind glass remain. Weighted OIT improves coverage transparency; it does not provide order-independent refraction. Pose uploads and deformation compute remain separate and complete before shadow/color/OIT rendering.

### Mipmap filtering

`renderer/textures/mipmaps.ts` computes the exact source footprint of each destination texel and averages every overlapping source texel by its covered area. A 5-pixel row becomes two footprints of width 2.5, so shared middle texels contribute fractionally and the last column is retained. A 3×1 row averages all three pixels instead of sampling only the middle pixel. Even dimensions use the ordinary 2×2 mean; one-pixel dimensions remain valid. Positive box weights preserve average energy without introducing ringing or overshoot. This improves odd-sized minification over the previous single bilinear lookup.

Explicit `textureLoad` operations read RGB in linear light from sRGB views, and the sRGB render attachment re-encodes it; alpha and data maps remain linear. This follows [WebGPU’s sRGB texture conversion rules](https://www.w3.org/TR/webgpu/#texture-formats). Each pass reads only the preceding level and writes a disjoint mip subresource. A step covers up to 3×3 source texels instead of one bilinear lookup, adding load-time shader work. Per-level RGBA8 quantization remains, and the filter is a box average rather than a sharper reconstruction kernel.

For **BLEND base-color** maps, filtering temporarily multiplies linear RGB by alpha, averages RGB and alpha, then divides RGB by the averaged alpha to restore the straight-alpha representation expected by the material shader. Fully transparent footprints produce zero RGB/alpha. This reduces mip color bleeding from hidden texels. Opaque/MASK base color, emissive, normal, metallic/roughness, and other data maps use ordinary area averages; emissive color and data channels are independent of image alpha. The image cache includes the filtering policy for generated chains, so a source shared by translucent base color and emissive/opaque/data maps receives the correct mip chain for each use.

Authored KTX2 mip chains are uploaded unchanged and continue sharing one allocation per source/format; single-level decoded images use the same generator as PNG/JPEG. Sampler filters, anisotropy, neutral defaults, and the explicit material bind group layout are unchanged. Mipmap preparation runs only while loading images, outside pose upload, deformation compute, and frame rendering.

## Supported behavior and limits

- glTF JSON and GLB 2.0, relative/data URI buffers and images, and embedded GLB images.
- Selected/default scene, hierarchy, matrix or TRS transforms, repeated mesh instancing, and inverse-transpose normals for nonuniform scales.
- Indexed/non-indexed points, lines, line strips/loops, triangles, triangle strips/fans. Missing normals give useful flat shading for triangles; supply normals or an unlit material for points/lines.
- Float POSITION/NORMAL/UV/COLOR/TANGENT plus decoded normalized integer UV/color attributes and sparse accessors. TEXCOORD_n sets are available per texture; only COLOR_0 is consumed.
- All five core material textures: base color, emissive, metallic/roughness, normal (with scale), and occlusion (with strength). Material factors, vertex colors, OPAQUE/MASK/BLEND, double-sided materials, and KHR_materials_unlit are supported.
- JPEG/PNG browser-decoded images, KHR_texture_transform, wrap/filter sampler translation, GPU mipmap generation, and linear-light shading with sRGB decoding for color maps and linear sampling for data maps.

This is **not a complete glTF conformance implementation or a full PBR viewer**. Lighting uses GGX-style punctual lights, a small ambient term, and diffuse/specular environment lighting. Filtered shadow maps cover directional, point and spot lights. Four-sample MSAA smooths geometric edges. Weighted transparency avoids sorting artifacts but approximates overlapping colors; sorted mode and screen-space refraction retain their respective limitations.

Authored glTF cameras are ignored in favor of orbit controls. KHR_lights_punctual supplies authored lights; the viewer light is a fallback for scenes without light instances. Unsupported required extensions are rejected. The lighting, compression and material extensions below and KHR_texture_transform work whether optional or required. Other optional extensions are ignored. The parser performs targeted integrity checks but is not a substitute for the Khronos glTF Validator. Normal mapping is intended for triangles; supply unlit materials for points/lines without meaningful surface normals.

## Authored lights and shadows

[KHR_lights_punctual](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_lights_punctual/README.md) definitions are instantiated by nodes in the selected scene. Repeated references create separate light instances. Directional and spot lights follow the node's transformed local −Z axis; point and spot positions come from the world transform. Parent transforms and TRS animation apply. Directions are normalized, and node scale does not change intensity, range or cone angles. Colors are linear RGB, intensity defaults to one, and omitted range is infinite. The renderer supports up to **32 light instances** and rejects larger selected scenes rather than silently dropping lights.

Directional intensity uses the authored lux value without distance falloff. Point and spot intensity uses candela with inverse-square attenuation. A finite range uses `max(1 - (distance / range)^4, 0) / distance²`, giving zero light at and beyond the cutoff. Spotlights use a squared interpolation between the inner and outer cone cosines, with glTF's default angles of zero and π/4. Invalid colors, intensity, range, cone angles or node references fail candidate preparation and preserve the current model. Authored lights replace the fallback directional light; environment lighting and the small existing ambient term remain independent. Unlit materials bypass all lighting and shadows.

Shadows are enabled by default for the **first four positive-intensity lights in scene traversal order**. Remaining lights still illuminate the scene. A directional light uses one orthographic map fitted to the whole scene envelope; a spot uses one perspective map; a point uses six 90° cube-face projections. Omitted point/spot range uses scene bounds to choose the shadow far plane. These are renderer shadows, since glTF does not author shadow-map settings.

The depth pass uses the same instance storage, index buffers, and computed morph/skin vertex outputs as the color pass. It includes opaque and MASK triangle casters, using two-sided depth rasterization. MASK coverage uses the base-color texture's selected UV set and KHR_texture_transform, factor alpha and vertex alpha. BLEND and transmitting materials receive direct-light shadows but do not cast opaque ones. Points and lines do not cast shadow maps. Off-camera casters remain in shadow passes independently of camera frustum culling.

`PunctualLighting.update()` runs in the pose-upload phase, comparing light-node revisions and selected mesh/active-joint/morph dependencies. Held or paused poses reuse the maps, and unrelated animated nodes cannot invalidate them. When relevant data changes, shadow matrices and light records are uploaded before encoding. The renderer then runs deformation compute, ends that pass, renders shadow depth, and finally renders the HDR scene in the same command buffer. Camera movement, canvas resize, exposure and environment changes alone do not regenerate camera-independent maps.

One `depth32float` attachment is reused for every shadow view. Each pass copies depth into a GPU storage buffer, then the color shader performs explicit **3×3 PCF** comparisons. These copies never pass through the CPU. This retains the baseline 16 sampled-texture budget already used by twelve material slots, three environment maps and the transmission snapshot. All material variants and shadow pipelines keep the existing explicit material layout and neutral defaults. Shadows affect direct diffuse, specular and clearcoat lighting, leaving environment, ambient and emission contributions intact.

```ts
const renderer = await Renderer.create(canvas, showError, {
  shadows: true,
  shadowResolution: 512, // 256, 512 (default), or 1024; fixed for this renderer
});
renderer.setShadows({ enabled: false });
renderer.setShadows({ enabled: true, depthBias: 0.00005, normalBias: 0.002 });
console.log(renderer.shadowSettings); // copy of the current settings
console.log(renderer.shadowMemory); // current requested shadow-resource bytes after frame preparation
```

`depthBias` is a nonnegative normalized-depth comparison offset (maximum 0.1); `normalBias` is a nonnegative world-space offset along the receiver normal. The rasterizer also applies a small constant and slope-scaled bias. Adjust these for scene scale to balance self-shadow artifacts against detached shadows. Resolution stays fixed. Binding 4 always exists on the same explicit frame layout; before maps are needed it uses one initialized **4-byte neutral depth buffer**. During frame preparation, active shadow lights allocate exactly one map per directional/spot light and six per point light, up to four lights. Depth attachment and matrix storage are also lazy. Disabled shadows, zero-intensity lights, and scenes without opaque/MASK triangle casters require only the neutral buffer. Capacity shrinks on model replacement and releases on disabling shadows, taking effect in the next frame's upload phase. Static frames reuse allocations.

When capacity changes, opaque and transmission frame bind groups refresh before command encoding; pipeline layouts and material slots remain unchanged. At 512², measured requested shadow memory falls from about **25 MiB** reserved at startup to **4 bytes** idle, **2 MiB** for one directional light, or **7 MiB** for one point light. Four point lights still require about 25 MiB. `renderer.shadowMemory` reports maps, neutral bytes, sample-buffer bytes, depth-attachment bytes, matrix bytes and their total; light records and driver overhead are excluded. See [shadow memory measurements](docs/shadow-memory.md) for exact before/after values and reproduction. Dirty frames still incur one depth pass and GPU copy per active view. Scene/frame draw statistics count color geometry only, excluding shadow passes and presentation.

This initial implementation has no directional cascades, per-light shadow controls, area-light penumbrae, translucent shadow transmission, light-volume caster culling or seamless PCF across point-light cube faces. Whole-scene directional fitting trades detail for coverage, and bias/near-plane clipping can affect very small or very large scenes. The explicit bounds and face conventions live in `lighting/shadows/matrices.ts`; shadow pipelines are prepared and cached during loading in `lighting/shadows/pipelines.ts`.

## Compressed assets

Use the same **Open model**, **Load URL**, `loadFiles()` or `loadUrl()` entry points for compressed assets. No decoder configuration or CDN access is needed. For local `.gltf`, include the referenced `.bin` and `.ktx2` files; GLB can embed both geometry and texture payloads. `Renderer.setAsset()` expects an already prepared `Asset`, so external integrations should use these loading helpers rather than pass compressed JSON directly.

| Extension                                                                                                                      | Preparation                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/EXT_meshopt_compression)        | Decode attribute, triangle-index and index-sequence bufferViews, including octahedral, quaternion and exponential filters. This covers geometry, skin data, morph deltas and animation streams. URI-less fallback placeholders need no allocation.                   |
| [KHR_draco_mesh_compression](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_draco_mesh_compression) | Decode triangle meshes using unique attribute IDs and accessor component types. Integer normalization is preserved. Decoded accessors are primitive-specific; attributes outside the Draco payload retain their original data. Strips become decoded triangle lists. |
| [KHR_mesh_quantization](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_mesh_quantization)           | Repack integer positions and signed integer morph deltas to floats. Node transforms, inverse binds and UV transforms carry the authored dequantization scale/offset.                                                                                                 |
| [KHR_texture_basisu](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_basisu)                 | Transcode 2D ETC1S/UASTC KTX2 to supported BC7/ETC2/ASTC blocks with RGBA8 fallback, preserving authored mips. Generate mipmaps when only the base level is supplied. Select the extension image in preference to a PNG/JPEG fallback.                               |

Meshopt uses the lazily imported `meshoptimizer/decoder`. Draco and Basis use a short-lived worker shared by all compressed primitives and images in one load; it initializes each WASM module only when needed and terminates on success or failure. The `three` dependency supplies decoder scripts and WASM files only; no Three.js rendering code is imported. Vite emits these files with the application. Deploy the entire `dist` directory; a Content Security Policy must permit `blob:` workers, same-origin decoder scripts and WebAssembly compilation. Meshopt decoding currently runs on the loading thread.

Renderer creation requests only advertised optional `texture-compression-bc`, `texture-compression-etc2` and `texture-compression-astc` features. Basis KTX2 textures retain **BC7 RGBA**, **ETC2 RGBA8**, or **ASTC 4×4** blocks on the GPU instead of expanding them to RGBA8. Target preference is ASTC for UASTC, then BC7, then ETC2; the bundled transcoder does not support ETC1S-to-ASTC, so those images use the next supported target or RGBA8. Every selected compressed format includes alpha and all RGB channels. Unsupported devices use RGBA8. Single-level sources use RGBA8 for generated mipmaps, and base dimensions that are not multiples of four use RGBA8 to preserve their logical size and UV behavior.

Texture interpretation still comes from the material slot: color maps select the format's sRGB variant and data maps select its linear variant. The same source used for both creates two GPU textures, while compatible data slots share an allocation. Material bind group layouts, neutral defaults and sampler/anisotropy policy are unchanged. Authored mip chains are transcoded at their original dimensions and uploaded as blocks, including complete physical blocks for small mip tails. Compressed textures are sampled/copy destinations, never render attachments; no decompression or transcode work happens in frame phases. See [GPU texture compression](docs/texture-compression.md) for measured payloads, fallback rules and verification limits.

The viewer passes enabled capabilities into loaders to transcode once. Embedding applications can do the same:

```ts
const renderer = await Renderer.create(canvas, showError);
const asset = await loadUrl(modelUrl, { textureCompression: renderer.textureCompression });
await renderer.setAsset(asset);
```

`loadFiles(files, options)` accepts the same option. Omitting it preserves portable RGBA8 loader output; scene preparation then adapts retained KTX2 sources to the renderer's enabled features. Assets prepared for another device are re-transcoded from original image blobs when their blocks are unsupported. This uses a copied decoded-image map and does not mutate the caller's asset. Texture arrays, cubemaps, HDR Basis payloads, raw `.basis` files, and other KTX2 encodings remain unsupported.

Compression completes before scene preparation. Shared deformation inputs, pose revision tracking, frustum bounds and the separate pose-upload → compute → render phases therefore continue to operate on the existing canonical data. Decoding occurs once at load time, never during playback. This is a runtime normalization step, not a glTF re-export API.

Offline regression fixtures cover meshopt streams/filters, quantized geometry and morphs, Draco normalized colors, ETC1S/UASTC texture slots and authored mipmaps, GLB-embedded images, and compressed skin/animation data. `scripts/generate-draco-fixture.mjs` regenerates the original Draco quad; `draco3dgltf` is a test-only encoder dependency. The production smoke test exercises both emitted WASM decoders together.

## Material extensions

The loader accepts these extensions in `extensionsRequired` as well as optional material data:

| Extension                                                                                                                                          | Implemented behavior                                                                                                 | Texture channels and defaults                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [KHR_materials_clearcoat](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_clearcoat/README.md)                 | Separate coat reflection and normal basis; Fresnel attenuates the base layer, including emission                     | Linear intensity R and roughness G; independent linear RGB normal map. Factor/roughness default to zero                |
| [KHR_materials_specular](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_specular/README.md)                   | Dielectric reflection strength/color with scalar diffuse energy reduction; metals retain their base-color reflection | Linear strength A, sRGB color RGB. Strength/color default to one/white                                                 |
| [KHR_materials_ior](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_ior/README.md)                             | Dielectric reflectance and volume refraction                                                                         | Default 1.5; accepts values >= 1 and the zero compatibility sentinel for infinite effective IOR                        |
| [KHR_materials_emissive_strength](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_emissive_strength/README.md) | Multiplies linear emissive factor/map before HDR rendering                                                           | Default one; values above one retain highlight detail until tone mapping                                               |
| [KHR_materials_transmission](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_transmission/README.md)           | Transmits the opaque background while retaining reflection; replaces diffuse independently of alpha coverage         | Linear R multiplied by factor; factor defaults to zero                                                                 |
| [KHR_materials_volume](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_volume/README.md)                       | Baked thickness, projected refraction and Beer-Lambert absorption                                                    | Linear thickness G; thickness defaults to zero, attenuation color to white, omitted distance to infinite/no absorption |

All seven added maps use the same slot table, neutral textures, mipmaps, samplers, UV-set selection and KHR_texture_transform handling as core maps. Clearcoat normals start from the geometric normal, independently of the base normal map. Missing normal maps bypass perturbation. Eight factor vec4s and twelve UV transforms form one 512-byte uniform for every material and shader variant. Emissive strength is folded into the emissive factor during packing. Invalid extension factors, IOR, color vectors or attenuation distance fail preparation and retain the previous scene. Unlit shading continues to output the base color.

Transmission renders opaque geometry first, resolves it into linear HDR, and copies that result into a separate texture. A continuation pass loads preserved MSAA samples and depth, renders sorted transmitting instances, then ordinary transparent instances through weighted OIT (or sorted alpha blending when configured). The snapshot avoids attachment feedback; presentation applies exposure/tone mapping once after the final resolve. Binding group 0 always has a snapshot texture and filtering sampler, with a black neutral fallback. Material group 2 always has twelve texture/sampler pairs. With three lighting maps and one snapshot, the fragment shader uses sixteen sampled textures and fourteen samplers, fitting WebGPU's baseline limits.

Refraction is a screen-space approximation using authored thickness rather than traced geometry. World-to-mesh ray conversion accounts for affine node transforms, including nonuniform scale. Skinned output uses identity instance transforms, so thickness is an approximation in its deformed world space. Rough transmission uses a small four-tap screen-space filter; offscreen rays sample the filtered environment. The snapshot contains opaque geometry only: nested glass, transparent objects behind glass, internal reflections, and exact rough BTDF integration are not supported. Volume boundaries ignore `doubleSided`; this viewer does not model an observer inside the medium. Other material extensions, including sheen, iridescence, anisotropy and dispersion, remain unsupported.

## Animation and deformation

The implementation follows the [glTF animation and skinning rules](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#animations). `Pose` stores immutable authored defaults and reusable translation, rotation, scale, morph-weight, and world-matrix arrays. Clip changes restore every property before applying the new clip. Final sampled values are compared with the previous pose; world matrices are rebuilt only for changed transforms or descendants of a changed parent, in parent-first order. Track inputs are strictly increasing times in seconds and are clamped outside their key range.

- **STEP** holds the preceding key, including the correct value at an exact key time.
- **LINEAR** interpolates vectors/weights and uses shortest-path quaternion slerp for rotations.
- **CUBICSPLINE** uses Hermite interpolation with incoming/outgoing tangents scaled by the key interval in seconds. Rotations are normalized after interpolation. Weight outputs are unpacked by key, target, and tangent/value group.
- **Morph targets** add weighted POSITION/NORMAL/TANGENT deltas to immutable base attributes. Node weights override mesh defaults, and omitted weights are zero. Sparse target accessors are supported. Tangent morphs change XYZ while preserving the base handedness component.
- **Skinning** supports JOINTS_n/WEIGHTS_n influence sets, normalized integer weights, and optional float MAT4 inverse-bind matrices. Missing inverse binds are identity matrices. Joint matrices are `jointWorld * inverseBind`; weights are normalized across all influence sets for each vertex. Skinning follows morphing. Skinned positions are already world-space, so their draw uses an identity instance transform: the skinned mesh node's transform is not applied a second time. Normals use the inverse transpose of the blended transform and tangents use its linear part.

Deformation runs in a **WebGPU compute pass** before drawing. CPU animation sampling still evaluates node transforms and computes `jointWorld * inverseBind` palettes, but playback uploads only those matrices, morph weights, and instance transforms. Immutable base vertices, dense decoded morph deltas, and joint influences are uploaded once per primitive when loading and shared across its deforming nodes. Each 64-thread workgroup processes vertices independently, with a bounds guard for the final partial workgroup. Every invocation starts from the immutable base, applies morph deltas, then skins the result. The output buffer has STORAGE and VERTEX usage and is bound directly for drawing; there is no per-frame vertex upload or GPU readback.

The shared compute pipeline uses one explicit bind group layout for skin-only, morph-only, and combined deformation. Unused slots receive neutral buffers. Base, target, and output records contain three vec4s (position, normal, tangent), for a 48-byte stride matching [WGSL alignment rules](https://gpuweb.github.io/gpuweb/wgsl/#alignment-and-size). Position W is one, normal W and morph delta W are zero, and tangent W preserves handedness. Influence records contain a vec4u of joint indices followed by a vec4f of weights. The kernel computes inverse-transpose normals from the blended matrix's cofactors and determinant, with an identity fallback for singular transforms.

The renderer ends the compute pass before starting the render pass in the same command encoder. WebGPU orders these uses of the output buffer; no shader barrier or CPU wait is required between passes. Paused poses retain their GPU output until a seek or clip change. Static scenes retain the optimized instanced path and do not create a compute pipeline. Buffers and workgroup counts are checked against device limits; oversized deformation inputs are rejected rather than silently truncated. Outputs are owned by the scene and destroyed together on replacement or a failed load.

The frame loop keeps three explicit boundaries: `uploadPose(device, scene)` updates only changed joint palettes, morph weights, instance transforms, winding, bounds, and sorting centers, followed by light/shadow record uploads, CPU visibility selection and optional occlusion-proxy uploads; `encodeDeformation(encoder, scene)` dispatches the frame's pending deformations and ends its pass; shadow depth passes consume that output, then `encodeScene(encoder, scene, context)` consumes the prepared visibility runs and draws into HDR storage. Presentation follows scene rendering, and submission happens once after all encoding phases. The pending list is cleared at the start of every frame, so paused or held poses cannot replay stale dispatches while camera and display changes continue rendering. When adding deformation features, place new pose inputs in the upload phase and kernels in the compute phase; keep uploads and deformation dispatches out of render-pass encoding.

The CPU deformation evaluator remains an oracle for tests and runs once per node on load for exact initial camera bounds. Playback uses shared precomputed base/delta bounds, expands them for each node's signed morph weights, and unions joint-transformed envelopes for visibility bounds and transparent draw centers. This takes work proportional to target/joint counts rather than vertex counts and avoids GPU readbacks. Those conservative centers can be less accurate than centers of the deformed vertices; intersecting transparent meshes still have the usual draw-sorting limitations. Compatible nodes batch their compute dispatches as described below.

### Share immutable deformation inputs between nodes

`SceneBuilder.prepare()` acquires shared `ModelResources` for the original asset. That record owns a CPU `DeformationInputCache`, a `GpuDeformationInputCache`, and shared GPU allocations; scene resources own mutable outputs and a lease on the record. The CPU cache keys by primitive object identity and decodes POSITION/NORMAL/TANGENT bases, sparse morph deltas, and conservative bounds once. Each `Deformation` references those arrays but keeps its CPU reference output separate. Skin influences are decoded lazily when the primitive first has a skinned consumer, so morph-only nodes do not suddenly require valid skin attributes.

The GPU cache keys by decoded-input identity, packs the shared base and morph records once, and uploads each immutable buffer once. Skin influence buffers key by their shared decoded influence array; joint indices are relative to each node's palette, so different skins can use the same packed influences. Each skin's joint list, inverse binds, and joint-index range are still validated independently, including on cache hits. An incompatible second skin fails preparation rather than reusing the first skin's validation. Morph-only consumers use one cached neutral influence buffer and share the same base/morph buffers with skinned consumers.

Every node retains its own joint palette, morph weights, and deformed vertex output range. Compatible nodes use separate aligned slices of shared pose/output arenas; isolated nodes use standalone buffers. Updating one node cannot overwrite another node's pose or geometry. Immutable shared buffers have STORAGE usage and read-only bindings, without COPY_DST; playback writes only dynamic pose ranges and the active-job list. The explicit compute layout, morph-before-skin order, 48-byte vertex records, shader, and frame phases remain unchanged. UV/color/index data continues to share its existing scene uploads.

For example, three deforming nodes that use one primitive upload one base stream and one morph-delta stream instead of three copies of each. Their compatible skinned consumers also upload one packed influence stream, while all three nodes retain independent outputs. Separate primitive objects are not deduplicated by comparing accessor contents. The same original `Asset` object shares inputs across model instances and overlapping scene replacements on one renderer. A different asset object or renderer prepares fresh resources; unused records are evicted. Treat asset definitions and decoded arrays as immutable.

Shared GPU allocations are registered once with the model resource owner; standalone node buffers and batch arenas belong to the scene. Scene leases protect shared resources during failed preparation and overlapping replacement. The final lease releases the model allocations and evicts its cache record. Renderer disposal releases the active scene and its leases. Nodes never destroy shared inputs individually.

The renderer wires both caches automatically. Callers constructing the lower-level deformation classes directly can share one CPU cache and one GPU cache by passing them as the optional fifth arguments to `Deformation` and `GpuDeformation`; existing four-argument calls still work with private caches. Use the same scene/device/resource owner for all consumers of a GPU cache and keep it scoped to that scene preparation.

Playback supports looping weighted layers and crossfades. Additive blending, per-node masks, root-motion extraction, animation-pointer extensions, and runtime retargeting are not implemented. Camera framing uses the initial authored pose rather than the whole animation's swept bounds; zoom out if a clip moves beyond the initial view. Degenerate transforms use a safe normal-matrix fallback; collapsed geometry has no well-defined surface normal. Models containing unsupported required extensions remain rejected.

### Batch deformation work

Scene preparation groups nodes of each primitive by shared skin influences, separating morph-only and skinned consumers. Different skins can share a batch: each node has an independent joint palette, morph weights, and output slice. Base vertices, morph deltas, and influences remain shared immutable inputs. Singletons use the existing standalone compute path.

`renderer/deformation/batch.ts` plans arenas and active jobs. The upload phase writes changed pose slices and uploads a compact list of dirty slot indices. The compute phase binds each active batch once and dispatches `(ceil(vertexCount / 64), activeNodeCount)`: X addresses vertices and Y selects a job. The shader resolves that job to its pose/output offsets, applies morphs before skinning, and writes directly to the node's vertex range. Rendering and shadows bind that range using `outputOffset`; no gather/scatter copy, CPU readback, or per-frame bind-group creation is needed. A paused or unaffected node retains its output even when neighboring nodes in the same arena change.

Arena sizes respect both `maxStorageBufferBindingSize` and `maxBufferSize`; batch sizes also respect the Y dispatch limit. Oversized groups split into multiple batches, with any leftover singleton using standalone dispatch. Output offsets satisfy both storage-binding alignment and the 48-byte vertex stride. Palette slices accommodate the largest skin in the group. This padding can increase memory usage for tiny meshes or differently sized skins; batching reduces dispatch/binding calls, but does not reduce vertex arithmetic or guarantee faster rendering on every device. Nodes using different primitives do not batch together.

The batched layout has seven storage buffers plus a counts uniform, within WebGPU's baseline storage-binding budget. Neutral influence, weight, and palette slots preserve the same interface across skin-only, morph-only, and combined consumers. The standalone layout and `GpuDeformation.dispatch()` remain available for low-level callers. To opt into batching directly, create definitions with a shared CPU input cache, call `planDeformationBatches()` once per primitive, and pass each returned slot as the sixth `GpuDeformation` argument. Call `prepareDeformationBatches(pending)` after pose uploads and before `dispatchBatched()` in the compute pass. Use one device and scene resource owner for all members; destroy arenas once with that owner.

### Update only poses that actually change

`Pose.evaluate()` samples into reusable scratch arrays, then compares the final values with the previous pose. Comparing after sampling avoids marking a property dirty merely because it was temporarily reset to its authored default. Every node has independent `worldRevision` and `weightsRevision` counters. Morph changes do not dirty world matrices. A changed parent propagates world recomputation to descendants; revisions advance only if the resulting float32 world matrix changes. Equivalent quaternion signs, cancelled transforms, held STEP values, constant tracks, and repeated samples can therefore stay idle. Mixing visits active clip targets and outgoing targets needed to restore defaults. World evaluation visits those nodes and affected TRS descendants in parent order. Work lists are cached while layer membership stays constant; arbitrary interrupted-fade snapshots conservatively visit every node. Exact comparisons avoid discarding small legitimate animation movements.

Scene preparation classifies the union of authored TRS targets and descendants across all clips. Unaffected rigid instances stay grouped even when an animation exists. Animated rigid instances and all skinned/morphed outputs keep independent draw records. Static mirrored instances retain their own winding group, and BLEND/transmission instances retain separate draws for ordering. The original transform indices remain valid for culling, shadows and uploads. Treat prepared clips and hierarchy membership as immutable; load a replacement asset when editing their targets.

CPU phase profiling is optional and disabled by default:

```ts
const renderer = await Renderer.create(canvas, showError, { cpuProfiling: true });
// Copied measurements from the last completed synchronous frame, in milliseconds.
console.log(renderer.cpuTimings);
```

`cpuTimings` exposes animation, mixing, world evaluation, uploads, visibility, command encoding, submission and total frame times, plus sampled/visited node counts. Mixing and world times are nested inside animation time; do not add them again to the total. Upload timing includes camera/light/shadow preparation; visibility timing includes occlusion dependency checks and query-input uploads. These are CPU wall times, with browser timer granularity, rather than GPU execution or presentation times. When profiling is disabled the getter returns `undefined`. See [animation CPU measurements](docs/animation-performance.md) for before/after results and limitations.

Each render draw remembers its last world revision. Only affected unskinned draws rewrite their 128-byte instance record, normal matrix, winding, and world-space sorting center. Adjacent changed records are coalesced into uploads; gaps containing unchanged draws are excluded. A morph-only node moving in world space updates its instance transform without rerunning local-space deformation. A changed morph weight updates only that node's weights and deformation output, without uploading an unchanged instance matrix.

Each `GpuDeformation` also remembers its morph revision and the world revisions of its influencing skin joints. Positive-weight joint slots are prepared once with the immutable influence cache; unused skin joints do not trigger deformation or expand sorting bounds. Joint dependencies use world revisions, so movement of a joint's ancestor still updates all affected skins, including meshes using different skins with shared primitive inputs. Moving only a skinned mesh node does not reskin vertices that are already in world space. Changed weights upload only the weight buffer; changed joints upload only the palette. A node enters the compute list only when one of these inputs changed or its output has never been initialized.

The first frame of a newly attached scene initializes every deformation output once, even when the clip starts at the authored pose. Afterward, playing a clip does not imply GPU work for every node. `AnimationController.update(frameTimestamp)` returns true only when the evaluated pose changed or scene initialization is required. Playback time and UI notifications continue during STEP holds, while uploads and compute stay idle. Seeks, clip switches, loop boundaries, and restoration of the authored pose compare their final values in the same way.

Revision tracking belongs to `Pose.evaluate()` and the animation API. Lower-level callers that directly edit pose arrays can still use `GpuDeformation.update()` for explicit full uploads; renderer playback uses `updateChanged()` instead. Treat revision counters as read-only to consumers.

`AnimationController` owns playback state and timing independently of WebGPU and the DOM. It selects clips, clamps seeks, loops time, handles pause/resume, and evaluates the attached `Pose`. A new pose is attached only after scene preparation succeeds, so failed replacements preserve playback. The controller does not schedule frames or allocate GPU resources.

For programmatic playback, await `renderer.setAsset(asset)`, then use `renderer.animation.select(index)` (`-1` for authored pose), `renderer.animation.setPlaying(boolean)`, and `renderer.animation.seek(seconds)`. `renderer.animation.state` exposes clip names, selected index, time, duration, and playback state. Set `renderer.animation.onChange` to update UI after state changes and evaluated frames. The original renderer methods (`selectAnimation`, `setPlaying`, `seek`), `animationState`, and `onAnimationChange` remain forwarding aliases for existing callers.

### Animation blending

`AnimationController` owns layer clocks and crossfade timing; `animation/blending.ts` mixes reusable CPU local-pose arrays. Translation, scale, and morph weights use weighted linear interpolation. Rotations use normalized shortest-path quaternion SLERP. Each layer independently samples from authored defaults, including properties absent from that clip. Positive weights totaling less than one leave the remaining influence to the authored pose; totals above one normalize. Zero-weight layers contribute nothing. This is whole-pose blending, so two clips animating different nodes still blend each affected channel with the other clip’s authored values.

```ts
// Switch immediately (existing API), or fade to a clip starting at time zero.
renderer.animation.select(0);
renderer.animation.crossFadeTo(1, 0.5);

// Mix independent looping clips at explicit starting times.
renderer.animation.setLayers([
  { clip: 0, time: 0.25, weight: 0.6 },
  { clip: 1, time: 1.0, weight: 0.4 },
]);
renderer.animation.setPlaying(true);
```

`crossFadeTo(index, seconds = 0.3)` advances both outgoing and destination clocks. A zero duration switches immediately; `-1` fades back to authored defaults. Interrupting a fade captures the displayed local pose once and freezes it as the new outgoing source, avoiding a jump. Pause freezes every clock and transition, and resume excludes paused wall time. `select()` clears layers and transitions. `seek()`/Restart cancel a transition at its destination; with manually configured layers, seek changes only the primary (first) clock. `setLayers([])` restores defaults. Scene replacement clears all mixing state. Invalid clips, nonfinite times/durations/weights, negative weights/durations, or overflowing weight totals are rejected before state changes.

The existing state fields describe the primary configured layer (the destination during a fade). `state.layers` returns copies of the configured layers, while optional `state.transition` exposes `duration`, `elapsed`, and `progress`; outgoing transition sources are internal. `onChange` continues during holds. For more than two contributing orientations, rotations use sequential weighted SLERP in supplied layer order, with authored defaults first when needed. This is deterministic but order-dependent; two contributing orientations use ordinary SLERP.

Mixing precedes the existing final-pose revision comparisons. Stable interpolation keeps identical channels exact, including equivalent quaternion signs. Only changed world matrices or morph weights trigger pose uploads, dependent compute dispatches, bounds updates, or shadow refreshes. Immutable deformation inputs remain shared, and pose-upload → compute → shadow/color render phases are unchanged. Scratch pose arrays and transition sample records are reused each frame; snapshots are allocated only when interrupting a fade.

## Frustum culling

Culling is enabled by default. Each frame extracts six inward-facing planes from the current view-projection matrix, including the resized viewport aspect. WebGPU uses `0 <= z <= w`, so the near plane comes from matrix row 2, while the far plane comes from row 3 minus row 2. An instance is omitted only when its entire world-space axis-aligned bounding box lies outside a plane. Boundary tolerance and invalid-bound/degenerate-plane fallbacks favor keeping geometry visible.

Static bounds are prepared once. Animated bounds follow the existing per-node pose revisions: affine transforms account for rotation, reflections, nonuniform scale, and shear; morph intervals support negative weights; skin bounds union the active joints' transformed envelopes. Normalized nonnegative skin influences keep every blended position inside that union. Bounds update in the pose phase, followed by CPU visibility selection and any query-input uploads before command encoding. Offscreen meshes still upload changed pose inputs and compute deformation, so returning meshes have current output.

Opaque instanced batches retain their original transform indices. Adjacent visible instances form one draw; hidden gaps split the batch into contiguous runs without repacking GPU buffers. A fully visible batch remains one draw. Transparent instances are culled before depth sorting. Conservative boxes can retain some invisible geometry; the CPU check is linear in primitive-instance count, with no spatial hierarchy. Optional scale and occlusion filters are described below.

Use `renderer.setFrustumCulling(false)` to disable the frustum filter for comparison, or pass `{ frustumCulling: false }` as the third argument to `Renderer.create()`. `renderer.frustumCulling` exposes the current setting. `renderer.frameStats` returns the last frame's `{ draws, instances, culledInstances }`, counting actual scene draw calls and primitive instances, excluding compute, shadow, occlusion-query and presentation draws. The culled count combines the enabled visibility filters. A culled batch can generate more draws when visible runs are separated. The statistics returned by `setAsset()` remain the prepared scene totals used by the viewer.

### Occlusion and scale culling

The viewer provides an **Occlusion culling** toggle and **Minimum mesh size** control. Both optional filters start disabled: occlusion queries add GPU/readback overhead, and size culling intentionally discards small visible geometry. Frustum culling stays enabled by default. Each filter operates on primitive instances, retaining their original transform-buffer indices and merging adjacent survivors into draw runs.

```ts
const renderer = await Renderer.create(canvas, reportError, {
  occlusionCulling: true,
  scaleCulling: 2, // Skip projected bounds smaller than two physical viewport pixels.
});
renderer.setOcclusionCulling(false);
renderer.setScaleCulling(0); // Disable size culling; any finite nonnegative threshold is valid.
```

`renderer.occlusionCulling` and `renderer.scaleCulling` expose the current settings. Scale means the maximum width/height of the projected world-space AABB, measured in physical render pixels, including the renderer's device-pixel-ratio policy. It follows viewport size, camera zoom, instance transforms, skinning and morph bounds. Full bounds are measured before clipping to the screen. Boxes crossing the near plane, enclosing the camera, or containing invalid coordinates remain visible for both optional filters. No mesh simplification, LOD switching, or world-scale cutoff is involved.

Occlusion uses `renderer/scene/occlusion.ts` and `projected-bounds.ts`. After opaque/MASK rendering stores depth, a depth-only query pass tests each candidate's screen rectangle at its nearest bounding-box depth. A one-pixel coverage margin and small depth bias avoid precision-induced self occlusion. These proxies write neither depth nor color and match the scene's sample count. Queries run before transmission and BLEND rendering, so translucent surfaces cannot hide the opaque background required for refraction; MASK holes use the actual shaded/discarded depth.

Query results resolve into a GPU buffer, copy into a map-read buffer, and map asynchronously **after submission**. Frames never await mapping or GPU completion. Zero samples allow a later frame to omit the instance's geometry submission; unknown results draw normally. Scene replacement, camera/projection changes, resize, filter changes and changed opaque/MASK geometry invalidate the depth epoch. Unrelated nodes, light animation and presentation changes retain results. Geometry dependencies include rigid world transforms, morph weights and active skin joints; skinned output ignores mesh-node-only transforms. Moving BLEND/transmission receivers invalidate only their own results, with separate revisions rejecting stale in-flight answers. All unknown or invalidated instances fail open.

Known results are reused while those dependencies remain unchanged, avoiding repeated queries and bound projections. Two consecutive frames of camera/occluder movement suspend new queries; the next depth-stable frame resumes them. This saves query work when asynchronous history cannot persist, while rendering all unknown geometry during motion. `renderer.occlusionStats` exposes submitted queries, known/hidden instances, capacity, pending mapping, consecutive unstable frames and discarded results. `npm run bench:occlusion` measures query GPU time when timestamp queries are available, CPU frame encoding and synchronized completion across static/moving scenes. See [measurements and hierarchy investigation](docs/occlusion-benchmark.md) for raw before/after data and limits.

One in-flight readback bounds resource use and avoids mapping races. Each query frame tests at most 4096 candidates, further limited by storage/buffer sizes; larger candidate sets rotate through that budget. Unknown and near-plane candidates remain visible. Query buffers grow only when needed, survive scene replacement, and destroy with the renderer. Failed/discarded readbacks leave visibility open. The proxies are conservative, so loose deformation bounds and large screen rectangles can keep fully hidden geometry; this is not a hierarchical depth pyramid or an indirect GPU draw system. Query work can exceed the cost it saves for small scenes; compare frame timing with the toggle.

Visibility and query-input uploads occur after pose/bounds uploads and before command encoding. Compute deformation and shadow casters continue updating regardless of these color-scene visibility filters. Occlusion introduces a render query pass and a small asynchronous visibility readback, while deformed vertices still travel directly from compute to vertex bindings. Material layouts, neutral defaults, color-space decoding, and HDR/MSAA/transparency behavior stay consistent.

## Extending the renderer

Keep material texture slots on the same explicit bind group layout across variants, with neutral defaults. Decode color textures as sRGB and data textures as linear. Add shader flags only when they materially change the interface or algorithm. Preserve the separate pose-upload, compute, and render phases when adding deformation features. Larger scenes should split buffers at device limits. Keep new rendering features isolated from file parsing and test their layout or ordering edge cases.

## Verification

`tests/lights.test.ts` checks selected-scene light instances, inherited transforms, defaults, invalid definitions, attenuation and all six point shadow projections. `browser-tests/lights.spec.ts` checks authored color/distance/cone/intensity and animated positions, visible directional/spot/point shadows, off-camera casters, MASK UV transforms, glass/BLEND caster policy, and compute → shadow → color ordering. It also verifies map reuse for held and unrelated poses and shadow toggling.

`tests/material-extensions.test.ts` checks extension defaults, HDR uniform packing, IOR/attenuation validation and extension UV overrides. `browser-tests/material-extensions.spec.ts` compares extension texture channels with equivalent factors, checks sRGB specular color and HDR emissive strength, and verifies transmission/absorption against known background radiance. It includes required-extension file loading, nonuniform thickness scaling, MSAA, resize and model replacement.

`tests/architecture.test.ts` enforces CPU/render/UI dependency boundaries and detects circular static imports. The behavior tests below continue to exercise the reorganized modules.

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

`tests/deformation-inputs.test.ts` checks shared decoded-array identity, independent CPU outputs, lazy influence decoding, distinct primitive/scene isolation, and joint-range validation for a second skin. The shared-input GPU regression verifies one upload for bases, morph deltas, and skin influences while differently weighted/skinned nodes continue to match the CPU oracle. `browser-tests/animation.spec.ts` also checks the renderer's actual scene-cache wiring and exactly-once buffer destruction after failed preparation, scene replacement, and disposal.

`tests/animation-controller.test.ts` verifies frame-time conversion and looping, pause/resume without time jumps, paused seeks, authored-pose restoration, scene replacement, static-pose reuse, notifications, and invalid playback requests without requiring a GPU or browser.

`tests/pose-changes.test.ts` checks per-node revisions, parent propagation, independent morph changes, STEP/constant samples, clip restoration, equivalent quaternion signs, and collapsed-parent cancellation. Controller tests also verify time/UI progression without GPU invalidation during STEP holds and repeated seeks. `browser-tests/pose-changes.spec.ts` instruments real uploads and dispatches to require work only for affected nodes: joint animation, morph weights, local mesh motion, parent motion, unused joints, and skinned mesh-node motion. It checks exact transform upload ranges, independent skins, first-output initialization, and no repeated work for identical poses.

```powershell
$env:TEST_REMOTE_MODELS = '1'
npm run test:browser
Remove-Item Env:TEST_REMOTE_MODELS
```

`tests/frustum.test.ts` covers all six WebGPU planes, perspective camera orientation, intersecting boxes, affine bounds, invalid/degenerate inputs, visible instance runs, and conservative signed-morph/skin bounds against the CPU oracle. `browser-tests/frustum.spec.ts` compares rendered pixels with culling enabled and disabled, checks actual visible run counts, camera movement, resizing, partial visibility, and offscreen skinned/morphed animation returning to view. The latter also exercises blended nonindexed draw submission.

Test your own textured and transparent assets before depending on broader feature coverage.

`tests/animation-blending.test.ts` covers weighted defaults, normalized totals, quaternion interpolation, independent clocks, paused/interrupted fades, authored restoration, unchanged revisions, replacement, and atomic validation. `browser-tests/animation-blending.spec.ts` compares actual renderer compute output to the CPU deformation oracle through mixed skin/morph poses and interrupted fades, checks upload → compute → render ordering, and requires unchanged poses to skip deformation.

`tests/radiance.test.ts` checks RGBE values above one, black pixels, modern literal/run packets, legacy multi-byte runs across scanlines, orientation, CRLF/metadata, nameless Blob detection, malformed data, and float16 limits. Environment browser tests load a real encoded HDR fixture through GPU filtering and read back every irradiance face and specular mip, then exercise the HDR/PIC file picker, retained lighting after failed replacements, and Studio restoration.

`browser-tests/mipmap-filtering.spec.ts` checks odd edge/corner impulses at every generated level, checkerboard energy, thin images, linear-light sRGB averages, alpha-weighted versus independent data/color mips, real MaterialFactory cache separation, browser PNG and decoded-image paths, all-transparent footprints, and unchanged authored KTX2 mip levels.

`browser-tests/transparency.spec.ts` reverses both draw order and triangles inside an intersecting primitive, compares weighted stability against sorted-order sensitivity, checks background coverage, opaque occlusion, zero/low/full alpha, HDR radiance, exposure independence, scene replacement/failure, invalid modes, and exactly-once attachment cleanup after resize/disposal. A separate per-pixel regression verifies single-sample and MSAA OIT compositing with different layer coverage, requiring the composite to precede HDR resolve.

`browser-tests/deformation-batching.spec.ts` checks actual two-dimensional GPU dispatches against the CPU oracle, independent output ranges, dirty slot holes, partially filled workgroups, different skin palettes, device-limit splitting, singleton fallback, and unchanged output reuse. The renderer blending regression checks batched dispatch counts, draw vertex offsets, and upload → compute → render ordering.

`tests/projected-bounds.test.ts` checks perspective/orthographic size, viewport/distance scaling, flattened bounds, and near-plane/invalid fail-open behavior. `browser-tests/visibility-filters.spec.ts` verifies pixel-identical opaque occlusion in MSAA and single-sample modes, delayed stale-result rejection, camera/resize/replacement invalidation, size thresholds, transparent occluder exclusions, and continued skin/morph compute with upload-before-encoding ordering.
