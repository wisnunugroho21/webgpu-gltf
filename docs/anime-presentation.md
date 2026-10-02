# Phase 6 toon lighting and outlines

The renderer accepts project-authored `material.extras.engine.toon` policy. This is optional glTF extras metadata, not a claimed Khronos extension. PBR rendering remains the default. The playable game authors this policy on its original block characters and adds shared hair/eye geometry; it remains placeholder art rather than a production anime character.

```ts
const material = {
  pbrMetallicRoughness: {
    baseColorFactor: [0.15, 0.65, 0.5, 1],
    metallicFactor: 0,
    roughnessFactor: 1,
  },
  extras: {
    engine: {
      toon: {
        threshold: 0.55,
        softness: 0.02,
        shadowLevel: 0.3,
        shadowColor: [0.6, 0.65, 0.8],
        indirectStrength: 0.25,
        outlineWidth: 2,
        outlineColor: [0.015, 0.02, 0.04],
      },
    },
  },
};
```

Presence of the toon object enables a two-band diffuse response per authored light. `threshold` selects the light-facing boundary; `softness` gives a narrow smooth transition; `shadowLevel` and linear `shadowColor` define the low band. `indirectStrength` scales smooth ambient/environment contribution so it does not wash out the ramp. Authored attenuation, light colors/intensities, PCF shadows, emission, normal maps and alpha policy retain their existing paths. Specular, clearcoat and transmission remain existing material contributions; the diffuse ramp is a stylization, not a physical BRDF. Unlit preserves its standard base-color behavior.

Defaults: threshold 0.5, softness 0.02, shadow level 0.35, shadow color `[0.6,0.65,0.8]`, indirect strength 0.25, outline width zero and outline color `[0.015,0.02,0.04]`. Threshold/shadow level/colors/indirect strength validate `[0,1]`, softness `[0.0001,0.5]`, and width `[0,16]` physical pixels. Outline colors are finite nonnegative linear HDR values. Invalid policy fails candidate preparation and retains the active scene. CPU authored resources remain immutable after preparation; replacing a style currently uses normal asset/world preparation rather than mutable material edits.

## Hull rendering and limits

Nonzero outline width on OPAQUE/MASK triangle geometry creates cached inverted-hull pipelines. Their vertex stage consumes the **same already deformed vertex buffers** as surface rendering, expands along projected inverse-transpose normals at a constant physical-pixel width, and culls front faces. Reflection-specific winding switches along with the surface pipeline, including skinned roots. Both 1× and 4× MSAA use the scene's HDR/depth attachments. Alpha-mask sampling uses the shared material slots/transforms; shells do not cast extra shadows.

Outline draws follow opaque surfaces in the color pass. They introduce no pose upload, compute dispatch or physics/animation evaluation. Pixel width follows viewport dimensions supplied during the normal upload phase. Tone mapping/exposure apply to outline color through the existing HDR presentation pass. `FrameStats.draws` counts actual surface plus outline submissions; logical instance/culling counts still count model geometry once. Prepared scene draw counts describe geometry draws; pipeline counts include prepared outline variants.

Transparent/transmitting materials use toon shading but **do not generate outline hulls**: a back shell would darken transparent interiors and interfere with OVER/OIT and the transmission snapshot. Missing normals/nontriangle geometry reject requested hulls clearly. Closed meshes with authored normals work best; hard seams, open meshes and overlapping hulls can produce gaps or internal edges. Stencil/screen-space outlines and artist-authored smoothed outline normals are separate future additions.

Because unexpanded AABBs and query rectangles do not include pixel-expanded shells, outlined objects conservatively bypass frustum/scale/occlusion rejection. This avoids clipped silhouettes near screen boundaries and stale query suppression. It costs extra offscreen submissions; expanded screen bounds must be implemented and measured before enabling those filters for outlined receivers. Ordinary materials keep their previous culling behavior. Deformation and shadows always update independently of visibility.

## Binding migration

Material schema **version 2** changes the uniform from 512 to **560 bytes**: eleven factor vec4s (176 bytes) followed by the same twelve pairs of UV rows (384 bytes). Core/extension fields keep offsets 0–31 floats; toon/shadow tint/outline occupy 32–43; UV rows now start at float 44. CPU packing, WGSL color/shadow structs and `minBindingSize` migrate together. All material variants retain binding 0 and the same 24 texture/sampler bindings, neutral defaults and sRGB color/linear data semantics. Only the uniform gains vertex visibility for extrusion; textures remain fragment-visible.

Frame schema grows from 80 to **96 bytes**, appending viewport size after view-projection and eye. Existing matrix/camera offsets used by CPU culling stay unchanged. GPU layouts and resources are runtime-created, not serialized assets; external applications must recreate renderer/device resources when upgrading this schema. `materialLayoutVersion` documents the migration rather than pretending old binary uniforms remain compatible.

CPU schema tests and real GPU image fixtures verify lighting plateaus, bright-band separation, HDR exposure, transparent compositing, skin/morph deformation, mirrored winding, MSAA silhouette coverage and zero compute work on held poses. Existing viewer fixtures verify PBR/texture/shadow/transmission compatibility. See [gameplay animation](gameplay-animation.md) and [playable slice](playable-slice.md).
