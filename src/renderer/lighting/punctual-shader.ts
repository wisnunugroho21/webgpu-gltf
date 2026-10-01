import { maxPunctualLights } from '../../scene/lights';
import { maxShadowMaps } from './punctual';

export const punctualShader = /* wgsl */ `
struct Light { position: vec4f, colorRange: vec4f, directionScale: vec4f, spot: vec4f, shadow: vec4f }
struct Lighting { header: vec4f, lights: array<Light, ${maxPunctualLights}>, matrices: array<mat4x4f, ${maxShadowMaps}> }
@group(0) @binding(3) var<storage,read> lighting: Lighting;
@group(0) @binding(4) var<storage,read> shadowDepth: array<f32>;
fn pointFace(ray: vec3f) -> u32 {
  let axis=abs(ray);
  if(axis.x>=axis.y && axis.x>=axis.z){return select(1u,0u,ray.x>=0.0);}
  if(axis.y>=axis.z){return select(3u,2u,ray.y>=0.0);}
  return select(5u,4u,ray.z>=0.0);
}
fn shadowVisibility(light: Light, world: vec3f, normal: vec3f) -> f32 {
  if(light.shadow.x<0.0){return 1.0;}
  var face=0u;
  if(light.position.w==1.0){face=pointFace(world-light.position.xyz);}
  let layer=u32(light.shadow.x)+face;
  let clip=lighting.matrices[layer]*vec4f(world+normal*light.shadow.w,1.0);
  if(clip.w<=0.0){return 1.0;}
  let projected=clip.xyz/clip.w;
  let uv=projected.xy*vec2f(0.5,-0.5)+vec2f(0.5);
  if(any(uv<vec2f(0.0)) || any(uv>vec2f(1.0)) || projected.z<0.0 || projected.z>1.0){return 1.0;}
  let size=u32(lighting.header.y);
  let pixel=vec2i(uv*f32(size));
  let receiver=projected.z-light.shadow.z;
  var sum=0.0;
  // Explicit 3x3 PCF on GPU depth-buffer values, with no extra sampled-texture slot.
  // Clamp taps at face edges; this simple cube filter can show seams across point faces.
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let p=vec2u(clamp(pixel+vec2i(x,y),vec2i(0),vec2i(i32(size)-1)));
    let index=layer*size*size+p.y*size+p.x;
    sum+=select(0.0,1.0,receiver<=shadowDepth[index]);
  }}
  return sum/9.0;
}
struct LightSample { direction: vec3f, radiance: vec3f }
fn sampleLight(light: Light, world: vec3f) -> LightSample {
  var sample: LightSample;
  sample.direction=-light.directionScale.xyz;sample.radiance=light.colorRange.rgb;
  if(light.position.w!=0.0){
    let ray=light.position.xyz-world;
    let distanceSquared=max(dot(ray,ray),0.0001);
    let distance=sqrt(distanceSquared);
    sample.direction=ray*inverseSqrt(distanceSquared);
    var attenuation=1.0/distanceSquared;
    if(light.colorRange.w>0.0){attenuation*=max(1.0-pow(distance/light.colorRange.w,4.0),0.0);}
    if(light.position.w==2.0){
      let cosine=dot(-sample.direction,light.directionScale.xyz);
      let cone=clamp(cosine*light.directionScale.w+light.spot.x,0.0,1.0);
      attenuation*=cone*cone;
    }
    sample.radiance*=attenuation;
  }
  return sample;
}
`;
