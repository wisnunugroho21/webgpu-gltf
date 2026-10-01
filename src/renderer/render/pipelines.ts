import type { Geometry } from '../../gltf/geometry';
import type { GpuMaterial } from '../materials/factory';
import { shaderSource } from './shader';
import type { SceneSampleCount } from '../presentation/output';

export interface PipelineArgs {
  buffers: GPUVertexBufferLayout[];
  topology: GPUPrimitiveTopology;
  stripIndexFormat?: GPUIndexFormat;
  features: Geometry['features'];
  doubleSided: boolean;
  blend: boolean;
  mirrored: boolean;
}

export function pipelineArgs(
  geometry: Geometry,
  material: GpuMaterial,
  mirrored: boolean,
): PipelineArgs {
  return {
    buffers: geometry.bindings.map((binding) => binding.layout),
    topology: geometry.topology,
    stripIndexFormat:
      geometry.indices && geometry.topology.endsWith('strip')
        ? geometry.indices instanceof Uint32Array
          ? 'uint32'
          : 'uint16'
        : undefined,
    features: geometry.features,
    doubleSided: material.doubleSided,
    blend: material.alphaMode === 'BLEND',
    mirrored,
  };
}

/** Keys contain immutable GPU state, never buffer identities, material colors, or node IDs.
 * Cache lifetime is one prepared scene, preventing unbounded growth across model loads. */
export class PipelineCache {
  private pipelines = new Map<string, Promise<GPURenderPipeline>>();
  private shaders = new Map<string, GPUShaderModule>();
  constructor(
    private device: GPUDevice,
    private layout: GPUPipelineLayout,
    private format: GPUTextureFormat,
    private sampleCount: SceneSampleCount = 1,
  ) {}
  get size(): number {
    return this.pipelines.size;
  }
  get(args: PipelineArgs): Promise<GPURenderPipeline> {
    const key = JSON.stringify(args);
    let result = this.pipelines.get(key);
    if (!result) {
      const shaderKey = JSON.stringify(args.features);
      let module = this.shaders.get(shaderKey);
      if (!module) {
        module = this.device.createShaderModule({
          label: `glTF shader ${shaderKey}`,
          code: shaderSource(args.features),
        });
        this.shaders.set(shaderKey, module);
      }
      result = this.device.createRenderPipelineAsync({
        label: 'Cached glTF pipeline',
        layout: this.layout,
        vertex: { module, entryPoint: 'vertexMain', buffers: args.buffers },
        fragment: {
          module,
          entryPoint: 'fragmentMain',
          targets: [
            {
              format: this.format,
              blend: args.blend
                ? {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  }
                : undefined,
            },
          ],
        },
        primitive: {
          topology: args.topology,
          stripIndexFormat: args.stripIndexFormat,
          frontFace: args.mirrored ? 'cw' : 'ccw',
          cullMode: args.doubleSided ? 'none' : 'back',
        },
        depthStencil: {
          format: 'depth24plus',
          depthWriteEnabled: !args.blend,
          depthCompare: 'less',
        },
        // Count is fixed for this cache, like attachment format and bind group layouts.
        // Keep alpha-to-coverage off: MASK uses discard and BLEND uses glTF alpha blending.
        multisample: { count: this.sampleCount },
      });
      this.pipelines.set(key, result);
    }
    return result;
  }
}
