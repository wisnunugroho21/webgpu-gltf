/** Precompute image-based lighting once per environment. Cosine-weighted samples store
 * diffuse irradiance divided by pi; GGX importance samples produce roughness-dependent
 * specular mips. A separate job integrates the two split-sum BRDF coefficients. */
export const environmentFilterShader = /* wgsl */ `
@group(0) @binding(0) var panorama: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(2) var<uniform> job: vec4f; // roughness, mode (specular/diffuse/BRDF), size, reserved
const PI = 3.14159265359;
const SAMPLES = 128u;
fn hammersley(i: u32) -> vec2f {
  return vec2f(f32(i) / f32(SAMPLES), f32(reverseBits(i)) * 2.3283064365386963e-10);
}
fn basis(N: vec3f) -> mat3x3f {
  let up = select(vec3f(0, 0, 1), vec3f(1, 0, 0), abs(N.z) > 0.999);
  let T = normalize(cross(up, N));
  return mat3x3f(T, cross(N, T), N);
}
fn ggx(xi: vec2f, roughness: f32) -> vec3f {
  let a = roughness * roughness;
  let phi = 2.0 * PI * xi.x;
  let c = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let s = sqrt(max(0.0, 1.0 - c * c));
  return vec3f(cos(phi) * s, sin(phi) * s, c);
}
fn radiance(direction: vec3f) -> vec3f {
  let size = vec2i(textureDimensions(panorama));
  let uv = vec2f(atan2(direction.z, direction.x) / (2.0 * PI) + 0.5,
    acos(clamp(direction.y, -1.0, 1.0)) / PI);
  let p = uv * vec2f(size) - 0.5;
  let start = vec2i(floor(p)); let f = fract(p);
  // Manual bilinear sampling keeps rgba32float source maps portable without requiring
  // float32-filterable. Longitude wraps and latitude clamps at the poles.
  let x0 = ((start.x % size.x) + size.x) % size.x;
  let x1 = (x0 + 1) % size.x;
  let y0 = clamp(start.y, 0, size.y - 1); let y1 = clamp(start.y + 1, 0, size.y - 1);
  return mix(mix(textureLoad(panorama, vec2i(x0, y0), 0).rgb,
    textureLoad(panorama, vec2i(x1, y0), 0).rgb, f.x),
    mix(textureLoad(panorama, vec2i(x0, y1), 0).rgb,
    textureLoad(panorama, vec2i(x1, y1), 0).rgb, f.x), f.y);
}
fn faceDirection(face: u32, uv: vec2f) -> vec3f {
  var d = vec3f(1, -uv.y, -uv.x);
  switch face {
    case 1u: { d = vec3f(-1, -uv.y, uv.x); }
    case 2u: { d = vec3f(uv.x, 1, uv.y); }
    case 3u: { d = vec3f(uv.x, -1, -uv.y); }
    case 4u: { d = vec3f(uv.x, -uv.y, 1); }
    case 5u: { d = vec3f(-uv.x, -uv.y, -1); }
    default: {}
  }
  return normalize(d);
}
fn integrateBRDF(nv: f32, roughness: f32) -> vec2f {
  let V = vec3f(sqrt(1.0 - nv * nv), 0, nv);
  var result = vec2f(0);
  let k = roughness * roughness / 2.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let H = ggx(hammersley(i), roughness);
    let vh = max(dot(V, H), 0.0);
    let L = 2.0 * vh * H - V;
    let nl = max(L.z, 0.0); let nh = max(H.z, 0.0);
    if (nl > 0.0) {
      let G = nv / (nv * (1.0 - k) + k) * nl / (nl * (1.0 - k) + k);
      let visibility = G * vh / max(nh * nv, 0.00001);
      let Fc = pow(1.0 - vh, 5.0);
      result += vec2f(1.0 - Fc, Fc) * visibility;
    }
  }
  return result / f32(SAMPLES);
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(job.z);
  if (id.x >= size || id.y >= size) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(size);
  if (job.y == 2.0) {
    textureStore(destination, vec2i(id.xy), i32(id.z), vec4f(integrateBRDF(uv.x, uv.y), 0, 1));
    return;
  }
  let N = faceDirection(id.z, uv * 2.0 - 1.0);
  let rotation = basis(N);
  var color = vec3f(0); var total = 0.0;
  if (job.y == 0.0 && job.x == 0.0) { color = radiance(N); total = 1.0; }
  else {
    for (var i = 0u; i < SAMPLES; i++) {
      let xi = hammersley(i);
      var L: vec3f; var weight = 1.0;
      if (job.y == 1.0) {
        let phi = 2.0 * PI * xi.x; let s = sqrt(xi.y);
        L = rotation * vec3f(cos(phi) * s, sin(phi) * s, sqrt(1.0 - xi.y));
      } else {
        let H = rotation * ggx(xi, job.x);
        L = normalize(2.0 * dot(N, H) * H - N);
        weight = max(dot(N, L), 0.0);
      }
      color += radiance(L) * weight; total += weight;
    }
  }
  textureStore(destination, vec2i(id.xy), i32(id.z), vec4f(color / max(total, 0.00001), 1));
}
`;
