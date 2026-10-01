/** Shared extension lighting helpers. All samples here use explicit LOD, allowing calls
 * after alpha-mask discard. The opaque snapshot stays linear HDR until presentation. */
export const materialExtensionShader = /* wgsl */ `
fn maxChannel(v: vec3f) -> f32 { return max(v.x, max(v.y, v.z)); }
fn specularLobe(N: vec3f, L: vec3f, V: vec3f, roughness: f32) -> f32 {
  let H = safeNormalize(L + V);
  let nl = max(dot(N, L), 0.0); let nv = max(dot(N, V), 0.001);
  let nh = max(dot(N, H), 0.0);
  let a2 = pow(roughness, 4.0);
  let d = nh * nh * (a2 - 1.0) + 1.0;
  let distribution = a2 / max(3.14159265 * d * d, 0.000001);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let visibility = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  return distribution * visibility / max(4.0 * nl * nv, 0.001);
}
fn transmittedRadiance(input: VertexOutput, N: vec3f, V: vec3f, thickness: f32, roughness: f32, ior: f32) -> vec4f {
  // IOR zero denotes infinite effective IOR; use a finite reciprocal for Snell's law.
  let eta = select(1.0 / max(ior, 1.0), 0.0, ior == 0.0);
  let direction = safeNormalize(refract(-V, N, eta));
  let localDirection = vec3f(dot(input.toLocalX, direction), dot(input.toLocalY, direction), dot(input.toLocalZ, direction));
  let distance = thickness / max(length(localDirection), 0.000001);
  let exit = frame.viewProjection * vec4f(input.world + direction * distance, 1.0);
  let ndc = exit.xy / max(exit.w, 0.000001);
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let effectiveRoughness = roughness * select(clamp(ior * 2.0 - 2.0, 0.0, 1.0), 1.0, ior == 0.0);
  // A small screen-space filter approximates rough BTDF scattering, not ray tracing.
  let radius = effectiveRoughness * effectiveRoughness * 0.04;
  let size = vec2f(textureDimensions(transmissionScene));
  let spread = vec2f(radius, radius * size.x / size.y);
  var background = (
    textureSampleLevel(transmissionScene, transmissionSceneSampler, uv + spread, 0.0).rgb +
    textureSampleLevel(transmissionScene, transmissionSceneSampler, uv - spread, 0.0).rgb +
    textureSampleLevel(transmissionScene, transmissionSceneSampler, uv + vec2f(spread.x, -spread.y), 0.0).rgb +
    textureSampleLevel(transmissionScene, transmissionSceneSampler, uv + vec2f(-spread.x, spread.y), 0.0).rgb) * 0.25;
  // Offscreen rays fall back to the filtered environment. Nested transmissive surfaces
  // are not in the opaque snapshot; document this limitation rather than reading feedback.
  if (exit.w <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    background = environment.x * textureSampleLevel(reflectionTexture, environmentSampler, environmentDirection(direction), effectiveRoughness * environment.z).rgb;
  }
  return vec4f(background, distance);
}
`;
