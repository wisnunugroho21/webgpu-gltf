import { mat4, vec3 } from 'gl-matrix';
import type { Asset } from '../../gltf/types';
import { prepareGeometry } from '../../gltf/geometry';
import { collectInstances } from '../../gltf/scene';
import { Pose } from '../../scene/pose';
import { PunctualLights } from '../../scene/lights';
import { ShadowPipelineCache } from '../lighting/shadows/pipelines';
import { Deformation } from '../../scene/deformation';
import { DeformationInputCache } from '../../scene/deformation-inputs';
import { MaterialFactory, type GpuMaterial } from '../materials/factory';
import { PipelineCache, pipelineArgs } from '../render/pipelines';
import { Resources, uploadBuffer } from '../core/resources';
import { SceneBindings, instanceFloatCount } from '../core/bindings';
import { GeometryUploader } from './geometry-uploader';
import { DeformationCompute } from '../deformation/compute';
import { GpuDeformation } from '../deformation/instance';
import { GpuDeformationInputCache } from '../deformation/inputs';
import { planDeformationBatches } from '../deformation/batch';
import { materialTextureSlots } from '../materials/slots';
import { textureCoordinates } from '../../gltf/texture-coordinates';
import { MipmapGenerator } from '../textures/mipmaps';
import { hdrFormat, type SceneSampleCount } from '../presentation/output';
import { createBounds, transformBounds, type Bounds } from './frustum';
import type { Draw, PoseDraw, Scene } from './types';
import type { TransparencyMode } from '../render/transparency';

/** Load-time work only: every candidate owns its allocations before scene replacement. */
export class SceneBuilder {
  private compute?: DeformationCompute;
  constructor(
    private device: GPUDevice,
    private bindings: SceneBindings,
    private mipmaps: MipmapGenerator,
    private sampleCount: SceneSampleCount,
    private transparency: TransparencyMode = 'sorted',
  ) {}

  async prepare(asset: Asset, resources: Resources): Promise<Scene> {
    const pose = new Pose(asset);
    const lights = new PunctualLights(pose);
    const shadowPipelines = new ShadowPipelineCache(this.device, this.bindings.shadowPipeline);
    // Scene-scoped immutable inputs are decoded/packed/uploaded once per primitive.
    // Per-node pose data and output remain independent, including different skins.
    const deformationInputs = new DeformationInputCache(asset);
    const gpuDeformationInputs = new GpuDeformationInputCache(this.device, resources);
    const updates: PoseDraw[] = [];
    const primitiveInstances = collectInstances(asset.gltf);
    if (
      !this.compute &&
      [...primitiveInstances].some(
        ([primitive, instances]) =>
          primitive.targets?.length ||
          instances.some((instance) => asset.gltf.nodes![instance.node].skin !== undefined),
      )
    )
      this.compute = await DeformationCompute.create(this.device);
    const materials = new MaterialFactory(
      this.device,
      asset,
      resources,
      this.bindings.materials,
      this.mipmaps,
    );
    const pipelines = new PipelineCache(
      this.device,
      this.bindings.pipeline,
      hdrFormat,
      this.sampleCount,
      this.transparency,
    );
    const uploader = new GeometryUploader(this.device, asset, resources);
    const opaque: Scene['opaque'] = new Map();
    const transparent: Draw[] = [];
    const transmission: Draw[] = [];
    const allDraws: Draw[] = [];
    const transforms: number[] = [];
    const min = vec3.fromValues(Infinity, Infinity, Infinity);
    const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
    let draws = 0;
    let instanceCount = 0;

    for (const [primitive, instances] of primitiveInstances) {
      const baseGeometry = prepareGeometry(asset, primitive);
      const definitions = new Map<number, Deformation>();
      for (const instance of instances)
        if (primitive.targets?.length || asset.gltf.nodes![instance.node].skin !== undefined)
          definitions.set(
            instance.node,
            new Deformation(asset, primitive, instance.node, pose, deformationInputs),
          );
      const batchSlots = definitions.size
        ? planDeformationBatches(this.device, resources, this.compute!, gpuDeformationInputs, [
            ...definitions.values(),
          ])
        : undefined;
      const independent =
        pose.clips.length > 0 ||
        !!primitive.targets?.length ||
        instances.some((instance) => asset.gltf.nodes![instance.node].skin !== undefined);
      // Pose-dependent geometry needs node-owned output; static scenes retain instancing.
      for (const run of independent ? instances.map((instance) => [instance]) : [instances]) {
        const deformation =
          primitive.targets?.length || asset.gltf.nodes![run[0].node].skin !== undefined
            ? new GpuDeformation(
                this.device,
                resources,
                definitions.get(run[0].node)!,
                this.compute!,
                gpuDeformationInputs,
                batchSlots?.get(definitions.get(run[0].node)!),
              )
            : undefined;
        const geometry = deformation ? deformation.geometry(baseGeometry) : baseGeometry;
        const material = await materials.get(primitive.material);
        const materialDefinition = asset.gltf.materials?.[primitive.material!];
        for (const slot of materialTextureSlots) {
          const info = slot.read(materialDefinition ?? {});
          if (!info) continue;
          const set = textureCoordinates(info)[3];
          if (!geometry.features.uvSets?.includes(set))
            throw new Error(`${slot.label} texture requires missing TEXCOORD_${set}.`);
        }
        const { vertices, index } = uploader.upload(primitive, geometry, deformation);
        const localMin = vec3.fromValues(Infinity, Infinity, Infinity);
        const localMax = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < geometry.positions.length; i += 3)
          for (let c = 0; c < 3; c++) {
            localMin[c] = Math.min(localMin[c], geometry.positions[i + c]);
            localMax[c] = Math.max(localMax[c], geometry.positions[i + c]);
          }
        const localBounds = { min: localMin, max: localMax };
        // Mirrored transforms reverse winding, so they require a separate frontFace pipeline.
        // Blended instances are individual draws because their camera order can change each frame.
        const batches =
          material.alphaMode === 'BLEND' || material.transmission
            ? run.map((instance) => [instance])
            : [run.filter((i) => !i.mirrored), run.filter((i) => i.mirrored)].filter(
                (batch) => batch.length,
              );
        for (const batch of batches) {
          const firstInstance = transforms.length / instanceFloatCount;
          const bounds: Bounds[] = [];
          for (const instance of batch) {
            const world = deformation?.data.skinned ? mat4.create() : instance.world;
            transforms.push(...world, ...(deformation?.data.skinned ? world : instance.normal));
            const instanceBounds = createBounds();
            transformBounds(instanceBounds, localBounds, world);
            bounds.push(instanceBounds);
            vec3.min(min, min, instanceBounds.min);
            vec3.max(max, max, instanceBounds.max);
          }
          const pipeline = await pipelines.get(
            pipelineArgs(geometry, material, deformation?.data.skinned ? false : batch[0].mirrored),
          );
          const draw: Draw = {
            pipeline,
            shadowPipeline:
              material.alphaMode !== 'BLEND' &&
              !material.transmission &&
              geometry.topology.startsWith('triangle')
                ? await shadowPipelines.get(pipelineArgs(geometry, material, false))
                : undefined,
            material,
            vertices,
            index,
            indexFormat: geometry.indices instanceof Uint32Array ? 'uint32' : 'uint16',
            count: geometry.count,
            firstInstance,
            instanceCount: batch.length,
            center: vec3.scale(
              vec3.create(),
              vec3.add(vec3.create(), bounds[0].min, bounds[0].max),
              0.5,
            ),
            depth: 0,
            bounds,
            visibleRuns: [],
          };
          const alternatives = independent
            ? [
                await pipelines.get(pipelineArgs(geometry, material, false)),
                await pipelines.get(pipelineArgs(geometry, material, true)),
              ]
            : [pipeline];
          if (independent)
            updates.push({
              draw,
              node: batch[0].node,
              deformation,
              normal: mat4.create(),
              localBounds: { min: vec3.clone(localMin), max: vec3.clone(localMax) },
              front: alternatives[0],
              mirrored: alternatives[1],
              worldRevision: -1,
            });
          if (material.transmission) transmission.push(draw);
          else if (material.alphaMode === 'BLEND') transparent.push(draw);
          else
            for (const option of alternatives) {
              const group = opaque.get(option) ?? new Map<GpuMaterial, Draw[]>();
              const list = group.get(material) ?? [];
              list.push(draw);
              group.set(material, list);
              opaque.set(option, group);
            }
          draws++;
          allDraws.push(draw);
          instanceCount += batch.length;
        }
      }
    }
    if (!draws) throw new Error('The selected scene contains no renderable mesh primitives.');
    if (transforms.length * 4 > this.device.limits.maxStorageBufferBindingSize)
      throw new Error('Scene transforms exceed this device’s storage-buffer binding limit.');
    const transformData = new Float32Array(transforms);
    const buffer = uploadBuffer(
      this.device,
      resources,
      transformData,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'Static scene instances',
    );
    const bindGroup = this.device.createBindGroup({
      layout: this.bindings.instances,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    return {
      lights,
      pose,
      updates,
      pendingDeformations: [],
      transformData,
      transformBuffer: buffer,
      resources,
      instances: bindGroup,
      opaque,
      transparent,
      visibleTransparent: [],
      transmission,
      visibleTransmission: [],
      draws: allDraws,
      min,
      max,
      stats: { pipelines: pipelines.size, draws, instances: instanceCount },
    };
  }
}
