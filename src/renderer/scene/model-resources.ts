import type { Asset, Primitive } from '../../gltf/types';
import { prepareGeometry, type Geometry } from '../../gltf/geometry';
import { DeformationInputCache } from '../../scene/deformation-inputs';
import { SceneBindings } from '../core/bindings';
import { Resources } from '../core/resources';
import { GpuDeformationInputCache } from '../deformation/inputs';
import { ShadowPipelineCache } from '../lighting/shadows/pipelines';
import { MaterialFactory } from '../materials/factory';
import { PipelineCache } from '../render/pipelines';
import type { TransparencyMode } from '../render/transparency';
import { hdrFormat, type SceneSampleCount } from '../presentation/output';
import { prepareTextureCompression } from '../textures/compression';
import type { MipmapGenerator } from '../textures/mipmaps';
import { GeometryUploader } from './geometry-uploader';

/** One device-specific model resource set, independent of entities and poses.
 * Never store transforms, joint palettes, morph weights or output buffers here. */
export class ModelResources {
  readonly deformationInputs: DeformationInputCache;
  readonly gpuDeformationInputs: GpuDeformationInputCache;
  readonly materials: MaterialFactory;
  readonly pipelines: PipelineCache;
  readonly shadowPipelines: ShadowPipelineCache;
  readonly uploader: GeometryUploader;
  private geometries = new Map<Primitive, Geometry>();

  private constructor(
    readonly asset: Asset,
    device: GPUDevice,
    bindings: SceneBindings,
    resources: Resources,
    mipmaps: MipmapGenerator,
    sampleCount: SceneSampleCount,
    transparency: TransparencyMode,
  ) {
    this.deformationInputs = new DeformationInputCache(asset);
    this.gpuDeformationInputs = new GpuDeformationInputCache(device, resources);
    this.materials = new MaterialFactory(device, asset, resources, bindings.materials, mipmaps);
    this.pipelines = new PipelineCache(
      device,
      bindings.pipeline,
      hdrFormat,
      sampleCount,
      transparency,
    );
    this.shadowPipelines = new ShadowPipelineCache(device, bindings.shadowPipeline);
    this.uploader = new GeometryUploader(device, asset, resources);
  }

  static async load(
    asset: Asset,
    device: GPUDevice,
    bindings: SceneBindings,
    resources: Resources,
    mipmaps: MipmapGenerator,
    sampleCount: SceneSampleCount,
    transparency: TransparencyMode,
  ): Promise<ModelResources> {
    return new ModelResources(
      await prepareTextureCompression(asset, device.features),
      device,
      bindings,
      resources,
      mipmaps,
      sampleCount,
      transparency,
    );
  }

  geometry(primitive: Primitive): Geometry {
    let geometry = this.geometries.get(primitive);
    if (!geometry) {
      geometry = prepareGeometry(this.asset, primitive);
      this.geometries.set(primitive, geometry);
    }
    return geometry;
  }
}
