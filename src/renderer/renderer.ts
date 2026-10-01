import { mat4, vec3 } from 'gl-matrix';
import type { Asset } from '../gltf/types';
import { prepareGeometry } from '../gltf/geometry';
import { collectInstances } from '../gltf/scene';
import { Pose } from '../gltf/animation';
import { Deformation } from '../gltf/deformation';
import { DeformationInputCache } from '../gltf/deformation-inputs';
import { OrbitCamera } from './camera';
import { MaterialFactory, materialLayoutEntries, type GpuMaterial } from './materials';
import { PipelineCache, pipelineArgs } from './pipelines';
import { Resources, uploadBuffer } from './resources';
import { DeformationCompute, GpuDeformation } from './deformation';
import { GpuDeformationInputCache } from './deformation-inputs';
import { AnimationController } from '../animation/controller';
import { materialTextureSlots } from './material-slots';
import { textureCoordinates } from '../gltf/texture-coordinates';
import { MipmapGenerator } from './mipmaps';
import { OutputPass, hdrFormat, type OutputSettings, type SceneSampleCount } from './output';
import { EnvironmentLighting, type EnvironmentSettings } from './environment';
import type { EnvironmentImage } from './environment-source';
import {
  Frustum,
  createBounds,
  transformBounds,
  visibleInstanceRuns,
  type Bounds,
} from './frustum';

interface Draw {
  pipeline: GPURenderPipeline;
  material: GpuMaterial;
  vertices: { buffer: GPUBuffer; offset: number }[];
  index?: GPUBuffer;
  indexFormat: GPUIndexFormat;
  count: number;
  firstInstance: number;
  instanceCount: number;
  center: vec3;
  depth: number;
  bounds: Bounds[];
  visibleRuns: number[];
}
export interface RendererOptions {
  /** Fixed at creation because attachments and all scene pipelines must agree. */
  sampleCount?: SceneSampleCount;
  /** Conservative per-instance bounds testing; enabled by default. */
  frustumCulling?: boolean;
}
/** Last frame's scene submissions, excluding compute and fullscreen presentation. */
export interface FrameStats {
  draws: number;
  instances: number;
  culledInstances: number;
}
interface Scene {
  pose: Pose;
  updates: PoseDraw[];
  pendingDeformations: GpuDeformation[];
  transformData: Float32Array;
  transformBuffer: GPUBuffer;
  resources: Resources;
  instances: GPUBindGroup;
  opaque: Map<GPURenderPipeline, Map<GpuMaterial, Draw[]>>;
  transparent: Draw[];
  visibleTransparent: Draw[];
  draws: Draw[];
  stats: { pipelines: number; draws: number; instances: number };
  min: vec3;
  max: vec3;
}
interface PoseDraw {
  draw: Draw;
  node: number;
  deformation?: GpuDeformation;
  normal: mat4;
  localBounds: Bounds;
  front: GPURenderPipeline;
  mirrored: GPURenderPipeline;
  worldRevision: number;
}

export class Renderer {
  readonly camera: OrbitCamera;
  readonly animation = new AnimationController();
  private scene?: Scene;
  private depth?: GPUTexture;
  private frameBuffer: GPUBuffer;
  private frameGroup: GPUBindGroup;
  private instanceLayout: GPUBindGroupLayout;
  private materialLayout: GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;
  private frameRequest = 0;
  private disposed = false;
  private width = 0;
  private height = 0;
  private frameData = new Float32Array(20);
  private compute?: DeformationCompute;
  private mipmaps: MipmapGenerator;
  private frustum = new Frustum();
  private cullingEnabled = true;
  private lastFrame: FrameStats = { draws: 0, instances: 0, culledInstances: 0 };
  get frameStats(): Readonly<FrameStats> {
    return { ...this.lastFrame };
  }
  get frustumCulling(): boolean {
    return this.cullingEnabled;
  }
  setFrustumCulling(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Frustum culling must be a boolean.');
    this.cullingEnabled = enabled;
  }
  get sampleCount(): SceneSampleCount {
    return this.output.sampleCount;
  }
  get environmentSettings(): Readonly<EnvironmentSettings> {
    return this.environment.settings;
  }
  setEnvironment(settings: Partial<EnvironmentSettings>): void {
    this.environment.setSettings(settings);
  }
  setEnvironmentMap(image: EnvironmentImage): Promise<void> {
    return this.environment.setImage(image);
  }
  get outputSettings(): Readonly<OutputSettings> {
    return this.output.settings;
  }
  setOutput(settings: Partial<OutputSettings>): void {
    this.output.setSettings(settings);
  }
  // Keep the original public playback API as small delegates for existing consumers.
  get onAnimationChange(): (() => void) | undefined {
    return this.animation.onChange;
  }
  set onAnimationChange(callback: (() => void) | undefined) {
    this.animation.onChange = callback;
  }
  get animationState() {
    return this.animation.state;
  }
  selectAnimation(index: number): void {
    this.animation.select(index);
  }
  setPlaying(playing: boolean): void {
    this.animation.setPlaying(playing);
  }
  seek(time: number): void {
    this.animation.seek(time);
  }

  static async create(
    canvas: HTMLCanvasElement,
    onError: (message: string) => void,
    options: RendererOptions = {},
  ): Promise<Renderer> {
    const sampleCount = options.sampleCount ?? 4;
    const frustumCulling = options.frustumCulling ?? true;
    if (typeof frustumCulling !== 'boolean') throw new Error('Frustum culling must be a boolean.');
    if (sampleCount !== 1 && sampleCount !== 4)
      throw new Error('Scene sample count must be 1 (off) or 4 (MSAA).');
    if (!navigator.gpu)
      throw new Error('WebGPU is unavailable. Use a WebGPU-capable browser on localhost or HTTPS.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available on this device.');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) {
      device.destroy();
      throw new Error('Could not create a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    let output: OutputPass | undefined;
    let environment: EnvironmentLighting;
    try {
      output = await OutputPass.create(device, format, sampleCount);
      environment = await EnvironmentLighting.create(device);
    } catch (error) {
      output?.destroy();
      device.destroy();
      throw error;
    }
    const renderer = new Renderer(canvas, device, context, format, onError, output, environment);
    renderer.setFrustumCulling(frustumCulling);
    device.addEventListener('uncapturederror', (event) => {
      renderer.stop();
      onError(`GPU error: ${event.error.message}`);
    });
    void device.lost.then((info) => {
      if (!renderer.disposed) {
        renderer.stop();
        onError(`WebGPU device lost: ${info.message || info.reason}. Reload to reconnect.`);
      }
    });
    return renderer;
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    private device: GPUDevice,
    private context: GPUCanvasContext,
    format: GPUTextureFormat,
    private onError: (message: string) => void,
    private output: OutputPass,
    private environment: EnvironmentLighting,
  ) {
    context.configure({ device, format, alphaMode: 'opaque' });
    this.mipmaps = new MipmapGenerator(device);
    this.camera = new OrbitCamera(canvas);
    const frameLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 80 },
        },
      ],
    });
    this.instanceLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage', minBindingSize: 128 },
        },
      ],
    });
    this.materialLayout = device.createBindGroupLayout({ entries: materialLayoutEntries });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, this.instanceLayout, this.materialLayout, environment.layout],
    });
    this.frameBuffer = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.frameGroup = device.createBindGroup({
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
    this.frameRequest = requestAnimationFrame(this.render);
  }

  /** Prepare a replacement fully before swapping. A failed load leaves the current model usable. */
  async setAsset(asset: Asset): Promise<Scene['stats']> {
    const resources = new Resources();
    this.device.pushErrorScope('validation');
    let candidate: Scene | undefined;
    let failure: unknown;
    try {
      candidate = await this.prepare(asset, resources);
    } catch (error) {
      failure = error;
    }
    const gpuError = await this.device.popErrorScope();
    if (failure || gpuError || this.disposed) {
      resources.destroy();
      throw failure ?? new Error(gpuError?.message ?? 'Renderer was disposed.');
    }
    const previous = this.scene;
    this.scene = candidate!;
    this.animation.setPose(candidate!.pose);
    this.camera.frame(candidate!.min, candidate!.max);
    previous?.resources.destroy();
    return candidate!.stats;
  }

  private async prepare(asset: Asset, resources: Resources): Promise<Scene> {
    const pose = new Pose(asset);
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
      this.materialLayout,
      this.mipmaps,
    );
    const pipelines = new PipelineCache(
      this.device,
      this.pipelineLayout,
      hdrFormat,
      this.sampleCount,
    );
    const views = new Map<number, GPUBuffer>();
    const indexBuffers = new Map<object, GPUBuffer>();
    const opaque: Scene['opaque'] = new Map();
    const transparent: Draw[] = [];
    const allDraws: Draw[] = [];
    const transforms: number[] = [];
    const min = vec3.fromValues(Infinity, Infinity, Infinity);
    const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
    let draws = 0;
    let instanceCount = 0;

    for (const [primitive, instances] of primitiveInstances) {
      const baseGeometry = prepareGeometry(asset, primitive);
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
                new Deformation(asset, primitive, run[0].node, pose, deformationInputs),
                this.compute!,
                gpuDeformationInputs,
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
        const vertices = geometry.bindings.map((binding) => {
          if (deformation?.source === binding.source)
            return { buffer: deformation.output, offset: 0 };
          if (typeof binding.source !== 'number') {
            const buffer = uploadBuffer(
              this.device,
              resources,
              binding.source,
              GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
              'Repacked attributes',
            );
            return { buffer, offset: 0 };
          }
          let buffer = views.get(binding.source);
          if (!buffer) {
            const view = asset.gltf.bufferViews![binding.source];
            buffer = uploadBuffer(
              this.device,
              resources,
              new Uint8Array(asset.buffers[view.buffer], view.byteOffset ?? 0, view.byteLength),
              GPUBufferUsage.VERTEX,
              `BufferView ${binding.source}`,
            );
            views.set(binding.source, buffer);
          }
          return { buffer, offset: binding.offset };
        });
        let index = indexBuffers.get(primitive);
        if (!index && geometry.indices) {
          index = uploadBuffer(
            this.device,
            resources,
            geometry.indices,
            GPUBufferUsage.INDEX,
            'Primitive indices',
          );
          indexBuffers.set(primitive, index);
        }
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
          material.alphaMode === 'BLEND'
            ? run.map((instance) => [instance])
            : [run.filter((i) => !i.mirrored), run.filter((i) => i.mirrored)].filter(
                (batch) => batch.length,
              );
        for (const batch of batches) {
          const firstInstance = transforms.length / 32;
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
          if (material.alphaMode === 'BLEND') transparent.push(draw);
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
      layout: this.instanceLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    return {
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
      draws: allDraws,
      min,
      max,
      stats: { pipelines: pipelines.size, draws, instances: instanceCount },
    };
  }

  private resize(): void {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(
      1,
      Math.min(
        this.device.limits.maxTextureDimension2D,
        Math.round(this.canvas.clientWidth * ratio),
      ),
    );
    const height = Math.max(
      1,
      Math.min(
        this.device.limits.maxTextureDimension2D,
        Math.round(this.canvas.clientHeight * ratio),
      ),
    );
    if (width === this.width && height === this.height) return;
    this.canvas.width = this.width = width;
    this.canvas.height = this.height = height;
    this.output.resize(width, height);
    this.depth?.destroy();
    this.depth = this.device.createTexture({
      label: 'Viewport depth',
      size: [width, height],
      format: 'depth24plus',
      // Depth coverage must match the HDR color attachment and scene pipelines.
      sampleCount: this.sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** Playback already evaluated the pose; this phase only updates render-side resources. */
  private uploadPose(scene: Scene): void {
    // Transform records follow draw order. Coalesce only adjacent dirty records, so
    // unchanged nodes are neither rewritten nor included in a whole-scene upload.
    let start = -1,
      end = -1;
    const flushTransforms = () => {
      if (start >= 0)
        this.device.queue.writeBuffer(
          scene.transformBuffer,
          start * 4,
          scene.transformData.buffer as ArrayBuffer,
          start * 4,
          (end - start) * 4,
        );
    };
    for (const update of scene.updates) {
      const deformationChanged = update.deformation?.updateChanged() ?? false;
      if (deformationChanged) scene.pendingDeformations.push(update.deformation!);
      const node = scene.pose.nodes[update.node];
      const worldChanged = node.worldRevision !== update.worldRevision;
      update.worldRevision = node.worldRevision;
      const skinned = update.deformation?.data.skinned;
      // Skinned output is already world-space. Moving only the mesh node cannot
      // require a transform upload or recomputation unless it also moves a joint.
      if (!worldChanged && !deformationChanged) continue;
      const world = node.world;
      if (worldChanged && !skinned) {
        if (!mat4.invert(update.normal, world)) mat4.identity(update.normal);
        mat4.transpose(update.normal, update.normal);
        const offset = update.draw.firstInstance * 32;
        scene.transformData.set(world, offset);
        scene.transformData.set(update.normal, offset + 16);
        update.draw.pipeline = mat4.determinant(world) < 0 ? update.mirrored : update.front;
        if (offset !== end) {
          flushTransforms();
          start = offset;
        }
        end = offset + 32;
      }
      if (skinned && !deformationChanged) continue;
      // Bounds depend on the same pose revisions as the output, so cached visibility
      // bounds cannot become stale when animated geometry crosses the frustum.
      if (deformationChanged)
        update.deformation!.data.bounds(update.localBounds.min, update.localBounds.max);
      const bounds = update.draw.bounds[0];
      if (skinned) {
        vec3.copy(bounds.min, update.localBounds.min);
        vec3.copy(bounds.max, update.localBounds.max);
      } else transformBounds(bounds, update.localBounds, world);
      vec3.scale(update.draw.center, vec3.add(update.draw.center, bounds.min, bounds.max), 0.5);
    }
    flushTransforms();
  }

  /** Encode deformation only after pose inputs have been uploaded. End this pass before
   * rendering so compute storage writes are available as vertex reads in the next pass.
   * New deformation kernels belong here; queue uploads belong in uploadPose. */
  private encodeDeformation(encoder: GPUCommandEncoder, scene: Scene): void {
    if (!scene.pendingDeformations.length) return;
    const pass = encoder.beginComputePass({ label: 'Scene deformation' });
    for (const deformation of scene.pendingDeformations) deformation.dispatch(pass);
    pass.end();
  }

  private render = (timestamp: number): void => {
    if (this.disposed) return;
    const scene = this.scene;
    // Phase 1: sample animation and upload its inputs before encoding any GPU work.
    if (scene) {
      // This list belongs to this frame; paused/held poses must not replay old dispatches.
      scene.pendingDeformations.length = 0;
      try {
        if (this.animation.update(timestamp)) this.uploadPose(scene);
      } catch (error) {
        this.stop();
        this.onError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    this.resize();
    this.frameData.set(this.camera.matrix(this.width / this.height));
    this.frameData.set(this.camera.eye, 16);
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
    const encoder = this.device.createCommandEncoder();
    // Phase 2: compute consumes uploaded inputs. Paused/static poses reuse their output.
    if (scene) this.encodeDeformation(encoder, scene);
    // Phase 3: render consumes completed deformation output in the same submission.
    this.encodeRender(encoder, scene);
    // Presentation follows scene rendering: tone mapping happens once, after all blending.
    this.output.encode(encoder, this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
    this.frameRequest = requestAnimationFrame(this.render);
  };

  /** Draw submission consumes prepared buffers; it neither uploads poses nor dispatches
   * deformation. Keep additional render passes after encodeDeformation in the frame loop. */
  private encodeRender(encoder: GPUCommandEncoder, scene: Scene | undefined): void {
    this.lastFrame.draws = 0;
    this.lastFrame.instances = 0;
    this.lastFrame.culledInstances = 0;
    if (scene) this.updateVisibility(scene);
    const pass = encoder.beginRenderPass({
      label: 'Scene rendering',
      colorAttachments: [
        // Resolve coverage in linear radiance, before the presentation pass tone maps it.
        this.output.sceneAttachment({ r: 0.001935, g: 0.002786, b: 0.004123, a: 1 }),
      ],
      depthStencilAttachment: {
        view: this.depth!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    if (scene) {
      pass.setBindGroup(0, this.frameGroup);
      pass.setBindGroup(1, scene.instances);
      pass.setBindGroup(3, this.environment.bindGroup);
      // Opaque rendering is deliberately organized by immutable state rather than the node tree.
      for (const [pipeline, materials] of scene.opaque) {
        pass.setPipeline(pipeline);
        for (const [material, draws] of materials) {
          pass.setBindGroup(2, material.bindGroup);
          for (const draw of draws)
            if (draw.pipeline === pipeline && draw.visibleRuns.length) this.draw(pass, draw);
        }
      }
      const forward = vec3.normalize(
        vec3.create(),
        vec3.subtract(vec3.create(), this.camera.target, this.camera.eye),
      );
      for (const draw of scene.visibleTransparent)
        draw.depth = vec3.dot(vec3.subtract(vec3.create(), draw.center, this.camera.eye), forward);
      scene.visibleTransparent.sort((a, b) => b.depth - a.depth);
      for (const draw of scene.visibleTransparent) {
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(2, draw.material.bindGroup);
        this.draw(pass, draw);
      }
    }
    pass.end();
  }

  /** Visibility consumes already updated pose bounds and the current camera matrix.
   * It never suppresses pose uploads/compute, so offscreen animation stays current. */
  private updateVisibility(scene: Scene): void {
    this.frustum.update(this.frameData);
    for (const draw of scene.draws) {
      visibleInstanceRuns(
        this.frustum,
        draw.bounds,
        draw.firstInstance,
        draw.visibleRuns,
        this.cullingEnabled,
      );
      this.lastFrame.draws += draw.visibleRuns.length / 2;
      for (let i = 1; i < draw.visibleRuns.length; i += 2)
        this.lastFrame.instances += draw.visibleRuns[i];
    }
    this.lastFrame.culledInstances = scene.stats.instances - this.lastFrame.instances;
    scene.visibleTransparent.length = 0;
    for (const draw of scene.transparent)
      if (draw.visibleRuns.length) scene.visibleTransparent.push(draw);
  }

  private draw(pass: GPURenderPassEncoder, draw: Draw): void {
    draw.vertices.forEach((binding, slot) =>
      pass.setVertexBuffer(slot, binding.buffer, binding.offset),
    );
    if (draw.index) pass.setIndexBuffer(draw.index, draw.indexFormat);
    // firstInstance still addresses the original transform storage buffer. Gaps
    // only change submission ranges; no transform upload or shader variant is needed.
    for (let i = 0; i < draw.visibleRuns.length; i += 2) {
      const first = draw.visibleRuns[i],
        count = draw.visibleRuns[i + 1];
      if (draw.index) pass.drawIndexed(draw.count, count, 0, 0, first);
      else pass.draw(draw.count, count, 0, first);
    }
  }
  private stop(): void {
    cancelAnimationFrame(this.frameRequest);
  }
  destroy(): void {
    this.disposed = true;
    this.stop();
    this.scene?.resources.destroy();
    this.depth?.destroy();
    this.output.destroy();
    this.environment.destroy();
    this.frameBuffer.destroy();
    this.camera.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
