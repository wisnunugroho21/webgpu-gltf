import type { Geometry } from '../../../gltf/geometry';
import { uvLocation } from '../../../gltf/texture-coordinates';
import { materialShaderStruct, materialTextureDeclarations } from '../../materials/slots';
import type { PipelineArgs } from '../../render/pipelines';

function source(features: Geometry['features']): string {
  const sets = features.uvSets ?? (features.uv ? [0] : []);
  return /* wgsl */ `
struct Instance { world: mat4x4f, normal: mat4x4f }
${materialShaderStruct}
@group(0) @binding(0) var<uniform> viewProjection: mat4x4f;
@group(1) @binding(0) var<storage,read> instances: array<Instance>;
@group(2) @binding(0) var<uniform> material: Material;
${materialTextureDeclarations}
struct Input {
  @location(0) position: vec3f,
  ${sets.map((set) => `@location(${uvLocation(set, sets)}) uv${set}: vec2f,`).join('\n')}
  ${features.color ? `@location(3) color: vec${features.color}f,` : ''}
  @builtin(instance_index) instance: u32,
}
struct Output { @builtin(position) clip: vec4f, @location(0) alpha: f32,
  ${sets.map((set) => `@location(${uvLocation(set, sets)}) uv${set}: vec2f,`).join('\n')}
}
@vertex fn vertexMain(input: Input) -> Output {
  var output: Output;
  output.clip=viewProjection*instances[input.instance].world*vec4f(input.position,1.0);
  ${sets.map((set) => `output.uv${set}=input.uv${set};`).join('\n')}
  output.alpha=${features.color === 4 ? 'input.color.a' : '1.0'};
  return output;
}
@fragment fn fragmentMain(input: Output) {
  // The same base-color UV selection/transform, factor, and vertex alpha as the color
  // pass determine MASK coverage. OPAQUE ignores alpha. Glass and BLEND do not cast.
  var uv=vec2f(0.0);let transform=material.uv[0];
  ${sets.map((set) => `if(transform.row0.w==${set}.0){uv=input.uv${set};}`).join('\n')}
  uv=vec2f(dot(transform.row0.xyz,vec3f(uv,1.0)),dot(transform.row1.xyz,vec3f(uv,1.0)));
  let alpha=textureSample(colorTexture,colorSampler,uv).a*material.baseColor.a*input.alpha;
  if(material.emissive.w==1.0 && alpha<material.parameters.z){discard;}
}`;
}

/** Separate single-sample depth pipelines, prepared during loading. Use two-sided
 * casters so thin sheets and mirrored/animated meshes do not lose their silhouettes. */
export class ShadowPipelineCache {
  private cache = new Map<string, Promise<GPURenderPipeline>>();
  constructor(
    private device: GPUDevice,
    private layout: GPUPipelineLayout,
  ) {}
  get(args: PipelineArgs): Promise<GPURenderPipeline> {
    const key = JSON.stringify([args.buffers, args.features, args.topology, args.stripIndexFormat]);
    let result = this.cache.get(key);
    if (!result) {
      const module = this.device.createShaderModule({
        label: 'Alpha-tested shadow shader',
        code: source(args.features),
      });
      result = this.device.createRenderPipelineAsync({
        label: 'Shadow depth pipeline',
        layout: this.layout,
        vertex: { module, entryPoint: 'vertexMain', buffers: args.buffers },
        fragment: { module, entryPoint: 'fragmentMain', targets: [] },
        primitive: {
          topology: args.topology,
          stripIndexFormat: args.stripIndexFormat,
          cullMode: 'none',
        },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'less',
          depthBias: 2,
          depthBiasSlopeScale: 2,
        },
      });
      this.cache.set(key, result);
    }
    return result;
  }
}
