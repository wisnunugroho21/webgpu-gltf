import type { Geometry } from '../gltf/geometry';

/** Variants are limited to missing vertex inputs. Material values remain uniform data,
 * so changing a color or supplying a texture doesn't create another pipeline. */
export function shaderSource(features: Geometry['features']): string {
  return /* wgsl */ `
struct Frame { viewProjection: mat4x4f, eye: vec4f }
struct Instance { world: mat4x4f, normal: mat4x4f }
// Three vec4 values = 48 bytes, matching the CPU material packing exactly.
struct Material { baseColor: vec4f, emissive: vec4f, parameters: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(2) @binding(0) var<uniform> material: Material;
@group(2) @binding(1) var colorSampler: sampler;
@group(2) @binding(2) var colorTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) position: vec3f,
  ${features.normal ? '@location(1) normal: vec3f,' : ''}
  ${features.uv ? '@location(2) uv: vec2f,' : ''}
  ${features.color ? `@location(3) color: vec${features.color}f,` : ''}
  @builtin(instance_index) instance: u32,
}
struct VertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) color: vec4f,
}
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let model = instances[input.instance];
  let world = model.world * vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.clip = frame.viewProjection * world;
  output.world = world.xyz;
  output.normal = ${features.normal ? '(model.normal * vec4f(input.normal, 0.0)).xyz' : 'vec3f(0.0)'};
  output.uv = ${features.uv ? 'input.uv' : 'vec2f(0.0)'};
  output.color = ${features.color === 4 ? 'input.color' : features.color === 3 ? 'vec4f(input.color, 1.0)' : 'vec4f(1.0)'};
  return output;
}

fn safeNormalize(v: vec3f) -> vec3f { return v * inverseSqrt(max(dot(v, v), 0.000001)); }
// Canvas is an unorm target, so encode linear lighting to sRGB explicitly.
fn linearToSrgb(v: vec3f) -> vec3f {
  let x = max(v, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
@fragment fn fragmentMain(input: VertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // sRGB texture views decode color into linear space; factors and vertex colors are linear.
  let base = textureSample(colorTexture, colorSampler, input.uv) * material.baseColor * input.color;
  let alphaMode = material.emissive.w; // 0 = opaque, 1 = mask, 2 = blend
  if (alphaMode == 1.0 && base.a < material.parameters.z) { discard; }
  var N = ${features.normal ? 'safeNormalize(input.normal)' : 'safeNormalize(cross(dpdx(input.world), dpdy(input.world)))'};
  ${features.normal ? 'if (!front) { N = -N; }' : '// Screen derivatives already follow the visible surface orientation.\n  if (dot(N, frame.eye.xyz - input.world) < 0.0) { N = -N; }'}
  let L = normalize(vec3f(0.4, 0.8, 0.6));
  let V = safeNormalize(frame.eye.xyz - input.world);
  let H = safeNormalize(L + V);
  let nl = max(dot(N, L), 0.0);
  let nv = max(dot(N, V), 0.001);
  let nh = max(dot(N, H), 0.0);
  let vh = max(dot(V, H), 0.0);
  let metallic = material.parameters.x;
  let roughness = max(material.parameters.y, 0.045);
  let a2 = pow(roughness, 4.0);
  let d = nh * nh * (a2 - 1.0) + 1.0;
  let distribution = a2 / max(3.14159265 * d * d, 0.000001);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let visibility = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  let f0 = mix(vec3f(0.04), base.rgb, metallic);
  let fresnel = f0 + (vec3f(1.0) - f0) * pow(1.0 - vh, 5.0);
  let specular = distribution * visibility * fresnel / max(4.0 * nl * nv, 0.001);
  let diffuse = (vec3f(1.0) - fresnel) * (1.0 - metallic) * base.rgb / 3.14159265;
  var color = (diffuse + specular) * nl * 3.0 + base.rgb * 0.12 + material.emissive.rgb;
  if (material.parameters.w == 1.0) { color = base.rgb; } // KHR_materials_unlit
  let alpha = select(1.0, base.a, alphaMode == 2.0);
  return vec4f(linearToSrgb(color), alpha);
}`;
}
