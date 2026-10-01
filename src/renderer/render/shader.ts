import type { Geometry } from '../../gltf/geometry';
import { materialTextureDeclarations, materialShaderStruct } from '../materials/slots';
import { materialExtensionShader } from '../materials/extensions-shader';
import { uvLocation } from '../../gltf/texture-coordinates';
import { punctualShader } from '../lighting/punctual-shader';

/** Variants cover vertex inputs and scene/weighted-transparency outputs. Material values
 * remain uniforms, so changing a color or texture doesn't create another pipeline. */
export function shaderSource(features: Geometry['features'], weighted = false): string {
  const uvSets = features.uvSets ?? (features.uv ? [0] : []);
  const volumeLocation = 5 + uvSets.filter((set) => set !== 0).length;
  return /* wgsl */ `
struct Frame { viewProjection: mat4x4f, eye: vec4f }
struct Instance { world: mat4x4f, normal: mat4x4f }
// Eight factor vec4s + twelve UV transforms = 512 bytes, matching CPU packing.
// textureParameters = normal scale, occlusion strength, normal-map presence, authored basis.
${materialShaderStruct}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var transmissionScene: texture_2d<f32>;
@group(0) @binding(2) var transmissionSceneSampler: sampler;
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(2) @binding(0) var<uniform> material: Material;
${materialTextureDeclarations}
// All variants share this scene lighting layout, independently of material slots.
@group(3) @binding(0) var environmentSampler: sampler;
@group(3) @binding(1) var irradianceTexture: texture_cube<f32>;
@group(3) @binding(2) var reflectionTexture: texture_cube<f32>;
@group(3) @binding(3) var brdfTexture: texture_2d<f32>;
@group(3) @binding(4) var<uniform> environment: vec4f; // intensity, yaw radians, max specular LOD, reserved
fn environmentDirection(direction: vec3f) -> vec3f {
  let c = cos(environment.y); let s = sin(environment.y);
  return vec3f(c * direction.x - s * direction.z, direction.y, s * direction.x + c * direction.z);
}

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
  @location(${volumeLocation}) toLocalX: vec3f,
  @location(${volumeLocation + 1}) toLocalY: vec3f,
  @location(${volumeLocation + 2}) toLocalZ: vec3f,
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
  // Normal-matrix columns are inverse-world rows: convert a world ray to mesh space.
  output.toLocalX = model.normal[0].xyz;
  output.toLocalY = model.normal[1].xyz;
  output.toLocalZ = model.normal[2].xyz;
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
fn mappedNormal(N: vec3f, tangent: vec3f, bitangent: vec3f, sample: vec3f, scale: f32) -> vec3f {
  // Gram-Schmidt corrects interpolated tangents and nonuniform node scales.
  let T = safeNormalize(tangent - N * dot(N, tangent));
  let handedness = select(-1.0, 1.0, dot(cross(N, T), bitangent) >= 0.0);
  let B = cross(N, T) * handedness;
  let local = vec3f(sample.xy * scale, sample.z);
  if (dot(T, T) < 0.001 || dot(local, local) < 0.000001) { return N; }
  return safeNormalize(T * local.x + B * local.y + N * local.z);
}
${materialExtensionShader}
${punctualShader}
${weighted ? 'struct TransparentOutput { @location(0) accumulation: vec4f, @location(1) opticalDepth: f32 }' : ''}
@fragment fn fragmentMain(input: VertexOutput, @builtin(front_facing) front: bool) -> ${weighted ? 'TransparentOutput' : '@location(0) vec4f'} {
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
  let coatWeight = textureSample(clearcoatTexture, clearcoatSampler, textureUV(input, 5u)).r * material.coat.x;
  let coatRoughness = clamp(textureSample(clearcoatRoughnessTexture, clearcoatRoughnessSampler, textureUV(input, 6u)).g * material.coat.y, 0.045, 1.0);
  let coatUV = textureUV(input, 7u);
  let coatSample = textureSample(clearcoatNormalTexture, clearcoatNormalSampler, coatUV).xyz * 2.0 - 1.0;
  let specularWeight = textureSample(specularStrengthTexture, specularStrengthSampler, textureUV(input, 8u)).a * material.specular.w;
  let specularColor = textureSample(specularColorTexture, specularColorSampler, textureUV(input, 9u)).rgb * material.specular.rgb;
  let transmissionWeight = textureSample(transmissionTexture, transmissionSampler, textureUV(input, 10u)).r * material.transmission.x;
  let thickness = textureSample(thicknessTexture, thicknessSampler, textureUV(input, 11u)).g * material.transmission.y;
  let alphaMode = material.emissive.w; // 0 = opaque, 1 = mask, 2 = blend
  var N = ${features.normal ? 'safeNormalize(input.normal)' : 'safeNormalize(cross(dpdx(input.world), dpdy(input.world)))'};
  ${features.normal ? '' : '// Screen derivatives already follow the visible surface orientation.\n  if (dot(N, frame.eye.xyz - input.world) < 0.0) { N = -N; }'}
  // Assets such as DamagedHelmet omit tangents. Recover a triangle-local basis from
  // position and UV derivatives, preserving mirrored UV orientation. This is a
  // fallback, not MikkTSpace generation; authored tangents give seam-consistent results.
  var coatN = N; // Clearcoat starts from the geometric normal, independent of the base map.
  let px = dpdx(input.world); let py = dpdy(input.world);
  let ux = dpdx(normalUV); let uy = dpdy(normalUV);
  let determinant = ux.x * uy.y - ux.y * uy.x;
  ${
    features.normal && features.tangent
      ? `if (material.textureParameters.z == 1.0 && material.textureParameters.w == 1.0) {
    N = mappedNormal(N, input.tangent.xyz, cross(N, input.tangent.xyz) * input.tangent.w, normalSample, material.textureParameters.x);
  } else`
      : ''
  }
  if (material.textureParameters.z == 1.0 && abs(determinant) > 0.00000001) {
    let T = (px * uy.y - py * ux.y) / determinant;
    let B = (py * ux.x - px * uy.x) / determinant;
    N = mappedNormal(N, T, B, normalSample, material.textureParameters.x);
  }
  let cx = dpdx(coatUV); let cy = dpdy(coatUV);
  let coatDeterminant = cx.x * cy.y - cx.y * cy.x;
  ${
    features.normal && features.tangent
      ? `if (material.coat.w == 1.0 && material.attenuation.w == 1.0) {
    coatN = mappedNormal(coatN, input.tangent.xyz, cross(coatN, input.tangent.xyz) * input.tangent.w, coatSample, material.coat.z);
  } else`
      : ''
  }
  if (material.coat.w == 1.0 && abs(coatDeterminant) > 0.00000001) {
    coatN = mappedNormal(coatN, (px * cy.y - py * cx.y) / coatDeterminant, (py * cx.x - px * cy.x) / coatDeterminant, coatSample, material.coat.z);
  }
  ${features.normal ? 'if (!front) { coatN = -coatN; }' : ''}
  ${features.normal ? '// Reverse the complete perturbed normal for double-sided back faces.\n  if (!front) { N = -N; }' : ''}
  // All texture samples and screen derivatives precede this nonuniform discard.
  if (alphaMode == 1.0 && base.a < material.parameters.z) { discard; }
  let V = safeNormalize(frame.eye.xyz - input.world);
  let nv = max(dot(N, V), 0.001);
  let metallic = clamp(material.parameters.x * mr.b, 0.0, 1.0);
  let roughness = clamp(material.parameters.y * mr.g, 0.045, 1.0);
  let ior = material.transmission.z;
  let dielectricF0 = select(pow((ior - 1.0) / (ior + 1.0), 2.0), 1.0, ior == 0.0);
  // Clamp color*IOR reflectance BEFORE strength; strength also scales grazing reflectance.
  let f0 = mix(min(vec3f(dielectricF0) * specularColor, vec3f(1.0)) * specularWeight, base.rgb, metallic);
  // Infinite-IOR compatibility keeps dielectric Fresnel angle independent, including
  // colored specular weighting. Metallic Fresnel retains its ordinary grazing limit.
  let dielectricF90 = select(vec3f(specularWeight), min(specularColor, vec3f(1.0)) * specularWeight, ior == 0.0);
  let f90 = mix(dielectricF90, vec3f(1.0), metallic);
  var directDiffuse=vec3f(0.0);var directSpecular=vec3f(0.0);var coatDirect=vec3f(0.0);
  let coatNv=max(dot(coatN,V),0.001);
  let coatFresnel=0.04+0.96*pow(1.0-clamp(coatNv,0.0,1.0),5.0);
  // Authored color/intensity and inverse-square/cone attenuation are linear radiance.
  // Shadows modulate direct diffuse/specular/coat, leaving IBL, ambient and emission intact.
  for(var i=0u;i<u32(lighting.header.x);i++) {
    let light=lighting.lights[i];let sample=sampleLight(light,input.world);let L=sample.direction;
    let nl=max(dot(N,L),0.0);let H=safeNormalize(L+V);let vh=max(dot(V,H),0.0);
    let fresnel=f0+(f90-f0)*pow(1.0-vh,5.0);
    let radiance=sample.radiance*shadowVisibility(light,input.world,N);
    // Scalar energy reduction avoids complementary tint in colored dielectric diffuse.
    directDiffuse+=(1.0-maxChannel(fresnel))*(1.0-metallic)*base.rgb/3.14159265*nl*radiance;
    directSpecular+=specularLobe(N,L,V,roughness)*fresnel*nl*radiance;
    coatDirect+=specularLobe(coatN,L,V,coatRoughness)*coatFresnel*max(dot(coatN,L),0.0)*radiance;
  }
  // Occlusion affects only indirect light: it must not dim the direct light or emission.
  let occlusion = mix(1.0, ao, material.textureParameters.y);
  // Split-sum IBL combines roughness-prefiltered radiance with integrated BRDF terms.
  // Explicit LOD sampling remains valid after the alpha-mask discard above.
  let irradiance = textureSampleLevel(irradianceTexture, environmentSampler, environmentDirection(N), 0.0).rgb;
  let reflected = textureSampleLevel(reflectionTexture, environmentSampler, environmentDirection(reflect(-V, N)), roughness * environment.z).rgb;
  let brdf = textureSampleLevel(brdfTexture, environmentSampler, vec2f(clamp(nv, 0.0, 1.0), roughness), 0.0).rg;
  let environmentFresnel = f0 + (max(vec3f(f90 - roughness), f0) - f0) * pow(1.0 - clamp(nv, 0.0, 1.0), 5.0);
  // Irradiance already includes the Lambertian 1/pi normalization.
  let indirectDiffuse = (1.0 - maxChannel(environmentFresnel)) * (1.0 - metallic) * base.rgb * irradiance;
  let indirectSpecular = reflected * (f0 * brdf.x + f90 * brdf.y);
  let transmissionAmount = transmissionWeight * (1.0 - metallic);
  let diffuseLighting = directDiffuse + (base.rgb * 0.12 + environment.x * indirectDiffuse) * occlusion;
  var color = diffuseLighting * (1.0 - transmissionAmount) + directSpecular + environment.x * indirectSpecular * occlusion + emission;
  if (transmissionWeight > 0.0 && metallic < 1.0) {
    let transmitted = transmittedRadiance(input, N, V, thickness, roughness, ior);
    var attenuation = vec3f(1.0);
    // Beer-Lambert absorption: omitted distance is encoded as inverse distance zero.
    if (transmitted.w > 0.0 && material.transmission.w > 0.0) {
      attenuation = pow(material.attenuation.rgb, vec3f(transmitted.w * material.transmission.w));
    }
    color += transmissionAmount * (1.0 - maxChannel(environmentFresnel)) * base.rgb * transmitted.rgb * attenuation;
  }
  if (coatWeight > 0.0) {
    let coatReflection = textureSampleLevel(reflectionTexture, environmentSampler, environmentDirection(reflect(-V, coatN)), coatRoughness * environment.z).rgb;
    let coatBrdf = textureSampleLevel(brdfTexture, environmentSampler, vec2f(clamp(coatNv, 0.0, 1.0), coatRoughness), 0.0).rg;
    let coatLight = coatDirect + environment.x * coatReflection * (0.04 * coatBrdf.x + coatBrdf.y) * occlusion;
    // Coat also attenuates emission, as it lies above all base material contributions.
    color = color * (1.0 - coatWeight * coatFresnel) + coatWeight * coatLight;
  }
  if (material.parameters.w == 1.0) { color = base.rgb; } // KHR_materials_unlit
  let alpha = select(1.0, base.a, alphaMode == 2.0);
  // Preserve HDR linear radiance for lighting and alpha blending. Display encoding and
  // tone mapping belong exclusively to the fullscreen presentation pass.
  ${
    weighted
      ? `
  let a = clamp(alpha, 0.0, 1.0);
  // Positive, bounded depth/opacity weights favor nearer, more opaque fragments.
  // Scale RGB by 1/256 to leave float16 accumulation headroom for bright layers.
  // A weight floor of one also keeps low-opacity LDR contributions above float16
  // underflow after RGB scaling; the upper bound leaves room for multiple HDR layers.
  let weight = clamp(pow(a + 0.01, 3.0) * 8.0 * pow(1.0 - input.clip.z * 0.9, 3.0) * 1000.0, 1.0, 16.0);
  var output: TransparentOutput;
  output.accumulation = vec4f(clamp(color, vec3f(0), vec3f(65504)) / 256.0 * a, a) * weight;
  // Add -log(1-alpha) instead of multiplying half-float revealage near one.
  // It represents the same coverage product with better low-opacity precision.
  output.opticalDepth = -log(max(1.0 - a, 0.00000001));
  return output;`
      : 'return vec4f(color, alpha);'
  }
}`;
}
