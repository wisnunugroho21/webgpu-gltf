import type { Geometry } from '../gltf/geometry';
import { materialTextureDeclarations } from './material-slots';
import { uvLocation } from '../gltf/texture-coordinates';

/** Variants are limited to missing vertex inputs. Material values remain uniform data,
 * so changing a color or supplying a texture doesn't create another pipeline. */
export function shaderSource(features: Geometry['features']): string {
  const uvSets = features.uvSets ?? (features.uv ? [0] : []);
  return /* wgsl */ `
struct Frame { viewProjection: mat4x4f, eye: vec4f }
struct Instance { world: mat4x4f, normal: mat4x4f }
// 64 bytes of factors + five 32-byte UV transforms = 224 bytes, matching CPU packing.
// textureParameters = normal scale, occlusion strength, normal-map presence, authored basis.
struct UVTransform { row0: vec4f, row1: vec4f }
struct Material { baseColor: vec4f, emissive: vec4f, parameters: vec4f, textureParameters: vec4f, uv: array<UVTransform, 5> }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(2) @binding(0) var<uniform> material: Material;
${materialTextureDeclarations}

struct VertexInput {
  @location(0) position: vec3f,
  ${features.normal ? '@location(1) normal: vec3f,' : ''}
  ${uvSets.map((set) => `@location(${uvLocation(set, uvSets)}) uv${set}: vec2f,`).join('\n  ')}
  ${features.color ? `@location(3) color: vec${features.color}f,` : ''}
  ${features.tangent ? '@location(4) tangent: vec4f,' : ''}
  @builtin(instance_index) instance: u32,
}
struct VertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  ${uvSets.map((set) => `@location(${uvLocation(set, uvSets)}) uv${set}: vec2f,`).join('\n  ')}
  @location(3) color: vec4f,
  @location(4) tangent: vec4f,
}
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let model = instances[input.instance];
  let world = model.world * vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.clip = frame.viewProjection * world;
  output.world = world.xyz;
  output.normal = ${features.normal ? '(model.normal * vec4f(input.normal, 0.0)).xyz' : 'vec3f(0.0)'};
  ${uvSets.map((set) => `output.uv${set} = input.uv${set};`).join('\n  ')}
  output.color = ${features.color === 4 ? 'input.color' : features.color === 3 ? 'vec4f(input.color, 1.0)' : 'vec4f(1.0)'};
  ${
    features.normal && features.tangent
      ? `
  // Tangents are surface directions: transform with world, not inverse transpose.
  // Reflections reverse the basis handedness as well as the primitive winding.
  let reflected = select(1.0, -1.0, dot(cross(model.world[0].xyz, model.world[1].xyz), model.world[2].xyz) < 0.0);
  output.tangent = vec4f((model.world * vec4f(input.tangent.xyz, 0.0)).xyz, input.tangent.w * reflected);`
      : 'output.tangent = vec4f(0.0);'
  }
  return output;
}

// Select coordinates independently for each slot, then apply scale → rotation → offset.
// Material values remain uniforms; UV-set selection/transforms never change bindings.
fn textureUV(input: VertexOutput, slot: u32) -> vec2f {
  let transform = material.uv[slot];
  var uv = vec2f(0.0);
  ${uvSets.map((set) => `if (transform.row0.w == ${set}.0) { uv = input.uv${set}; }`).join('\n  ')}
  let homogeneous = vec3f(uv, 1.0);
  return vec2f(dot(transform.row0.xyz, homogeneous), dot(transform.row1.xyz, homogeneous));
}

fn safeNormalize(v: vec3f) -> vec3f { return v * inverseSqrt(max(dot(v, v), 0.000001)); }
fn mappedNormal(N: vec3f, tangent: vec3f, bitangent: vec3f, sample: vec3f) -> vec3f {
  // Gram-Schmidt corrects interpolated tangents and nonuniform node scales.
  let T = safeNormalize(tangent - N * dot(N, tangent));
  let handedness = select(-1.0, 1.0, dot(cross(N, T), bitangent) >= 0.0);
  let B = cross(N, T) * handedness;
  let local = vec3f(sample.xy * material.textureParameters.x, sample.z);
  if (dot(T, T) < 0.001 || dot(local, local) < 0.000001) { return N; }
  return safeNormalize(T * local.x + B * local.y + N * local.z);
}
@fragment fn fragmentMain(input: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // sRGB texture views decode color into linear space; factors and vertex colors are linear.
  let base = textureSample(colorTexture, colorSampler, textureUV(input, 0u)) * material.baseColor * input.color;
  // Emissive factor scales the map; it is not uniform illumination of the surface.
  // Sample before conditional discard so texture derivatives stay in uniform control flow.
  let emission = textureSample(emissiveTexture, emissiveSampler, textureUV(input, 1u)).rgb * material.emissive.rgb;
  // glTF packs roughness in green and metallic in blue. Red is reserved here;
  // the occlusion slot can independently reuse that same image's red channel.
  let mr = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, textureUV(input, 2u));
  let normalUV = textureUV(input, 3u);
  let normalSample = textureSample(normalTexture, normalSampler, normalUV).xyz * 2.0 - 1.0;
  let ao = textureSample(occlusionTexture, occlusionSampler, textureUV(input, 4u)).r;
  let alphaMode = material.emissive.w; // 0 = opaque, 1 = mask, 2 = blend
  var N = ${features.normal ? 'safeNormalize(input.normal)' : 'safeNormalize(cross(dpdx(input.world), dpdy(input.world)))'};
  ${features.normal ? '' : '// Screen derivatives already follow the visible surface orientation.\n  if (dot(N, frame.eye.xyz - input.world) < 0.0) { N = -N; }'}
  // Assets such as DamagedHelmet omit tangents. Recover a triangle-local basis from
  // position and UV derivatives, preserving mirrored UV orientation. This is a
  // fallback, not MikkTSpace generation; authored tangents give seam-consistent results.
  let px = dpdx(input.world); let py = dpdy(input.world);
  let ux = dpdx(normalUV); let uy = dpdy(normalUV);
  let determinant = ux.x * uy.y - ux.y * uy.x;
  ${
    features.normal && features.tangent
      ? `if (material.textureParameters.z == 1.0 && material.textureParameters.w == 1.0) {
    N = mappedNormal(N, input.tangent.xyz, cross(N, input.tangent.xyz) * input.tangent.w, normalSample);
  } else`
      : ''
  }
  if (material.textureParameters.z == 1.0 && abs(determinant) > 0.00000001) {
    let T = (px * uy.y - py * ux.y) / determinant;
    let B = (py * ux.x - px * uy.x) / determinant;
    N = mappedNormal(N, T, B, normalSample);
  }
  ${features.normal ? '// Reverse the complete perturbed normal for double-sided back faces.\n  if (!front) { N = -N; }' : ''}
  // All texture samples and screen derivatives precede this nonuniform discard.
  if (alphaMode == 1.0 && base.a < material.parameters.z) { discard; }
  let L = normalize(vec3f(0.4, 0.8, 0.6));
  let V = safeNormalize(frame.eye.xyz - input.world);
  let H = safeNormalize(L + V);
  let nl = max(dot(N, L), 0.0);
  let nv = max(dot(N, V), 0.001);
  let nh = max(dot(N, H), 0.0);
  let vh = max(dot(V, H), 0.0);
  let metallic = clamp(material.parameters.x * mr.b, 0.0, 1.0);
  let roughness = clamp(material.parameters.y * mr.g, 0.045, 1.0);
  let a2 = pow(roughness, 4.0);
  let d = nh * nh * (a2 - 1.0) + 1.0;
  let distribution = a2 / max(3.14159265 * d * d, 0.000001);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let visibility = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  let f0 = mix(vec3f(0.04), base.rgb, metallic);
  let fresnel = f0 + (vec3f(1.0) - f0) * pow(1.0 - vh, 5.0);
  let specular = distribution * visibility * fresnel / max(4.0 * nl * nv, 0.001);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - metallic) * base.rgb / 3.14159265;
  // Occlusion affects only indirect light: it must not dim the direct light or emission.
  let occlusion = mix(1.0, ao, material.textureParameters.y);
  var color = (diffuse + specular) * nl * 3.0 + base.rgb * 0.12 * occlusion + emission;
  if (material.parameters.w == 1.0) { color = base.rgb; } // KHR_materials_unlit
  let alpha = select(1.0, base.a, alphaMode == 2.0);
  // Preserve HDR linear radiance for lighting and alpha blending. Display encoding and
  // tone mapping belong exclusively to the fullscreen presentation pass.
  return vec4f(color, alpha);
}`;
}
