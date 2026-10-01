import { mat4, vec3 } from 'gl-matrix';
import type { Asset } from '../gltf/types';
import { prepareGeometry } from '../gltf/geometry';
import { collectInstances } from '../gltf/scene';
import { Pose } from '../gltf/animation';
import { Deformation } from '../gltf/deformation';
import { OrbitCamera } from './camera';
import { MaterialFactory, materialLayoutEntries, type GpuMaterial } from './materials';
import { PipelineCache, pipelineArgs } from './pipelines';
import { Resources, uploadBuffer } from './resources';

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
}
interface Scene {
  pose: Pose;
  updates: PoseDraw[];
  transformData: Float32Array;
  transformBuffer: GPUBuffer;
  resources: Resources;
  instances: GPUBindGroup;
  opaque: Map<GPURenderPipeline, Map<GpuMaterial, Draw[]>>;
  transparent: Draw[];
  stats: { pipelines: number; draws: number; instances: number };
  min: vec3;
  max: vec3;
}
interface PoseDraw {
  draw: Draw;
  node: number;
  deformation?: Deformation;
  uploads: { data: Float32Array; buffer: GPUBuffer }[];
  normal: mat4;
  localCenter: vec3;
  front: GPURenderPipeline;
  mirrored: GPURenderPipeline;
}

export class Renderer {
  readonly camera: OrbitCamera;
  private scene?: Scene;
  private depth?: GPUTexture;
  private frameBuffer: GPUBuffer;
  private frameGroup: GPUBindGroup;
  private instanceLayout: GPUBindGroupLayout;
  private materialLayout: GPUBindGroupLayout;
  private pipelineLayout: GPUPipelineLayout;
  private animation = 0;
  private disposed = false;
  private width = 0;
  private height = 0;
  private frameData = new Float32Array(20);
  private clip = -1;
  private time = 0;
  private playing = true;
  private lastTime = 0;
  private poseDirty = false;
  onAnimationChange?: () => void;
  get animationState() {
    return {
      clips: this.scene?.pose.clips.map((clip) => clip.name) ?? [],
      clip: this.clip,
      time: this.time,
      playing: this.playing,
      duration: this.scene?.pose.clips[this.clip]?.duration ?? 0,
    };
  }
  selectAnimation(index: number): void {
    if (index !== -1 && !this.scene?.pose.clips[index]) throw new Error('Unknown animation clip.');
    this.clip = index;
    this.time = 0;
    this.poseDirty = true;
    this.lastTime = 0;
    this.onAnimationChange?.();
  }
  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.lastTime = 0;
    this.onAnimationChange?.();
  }
  seek(time: number): void {
    this.time = Math.max(0, Math.min(this.animationState.duration, time));
    this.poseDirty = true;
    this.lastTime = 0;
    this.onAnimationChange?.();
  }

  static async create(
    canvas: HTMLCanvasElement,
    onError: (message: string) => void,
  ): Promise<Renderer> {
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
    const renderer = new Renderer(
      canvas,
      device,
      context,
      navigator.gpu.getPreferredCanvasFormat(),
      onError,
    );
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
    private format: GPUTextureFormat,
    private onError: (message: string) => void,
  ) {
    context.configure({ device, format, alphaMode: 'opaque' });
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
      bindGroupLayouts: [frameLayout, this.instanceLayout, this.materialLayout],
    });
    this.frameBuffer = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.frameGroup = device.createBindGroup({
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
    this.animation = requestAnimationFrame(this.render);
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
    this.playing = true;
    this.selectAnimation(candidate!.pose.clips.length ? 0 : -1);
    this.camera.frame(candidate!.min, candidate!.max);
    previous?.resources.destroy();
    return candidate!.stats;
  }

  private async prepare(asset: Asset, resources: Resources): Promise<Scene> {
    const pose = new Pose(asset);
    const updates: PoseDraw[] = [];
    const primitiveInstances = collectInstances(asset.gltf);
    const materials = new MaterialFactory(this.device, asset, resources, this.materialLayout);
    const pipelines = new PipelineCache(this.device, this.pipelineLayout, this.format);
    const views = new Map<number, GPUBuffer>();
    const indexBuffers = new Map<object, GPUBuffer>();
    const opaque: Scene['opaque'] = new Map();
    const transparent: Draw[] = [];
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
      // Pose-dependent geometry needs node-owned streams; static scenes retain instancing.
      for (const run of independent ? instances.map((instance) => [instance]) : [instances]) {
        const deformation =
          primitive.targets?.length || asset.gltf.nodes![run[0].node].skin !== undefined
            ? new Deformation(asset, primitive, run[0].node, pose)
            : undefined;
        const geometry = deformation ? deformation.geometry(baseGeometry) : baseGeometry;
        const uploads: PoseDraw['uploads'] = [];
        const material = await materials.get(primitive.material);
        const materialDefinition = asset.gltf.materials?.[primitive.material!];
        if (
          (materialDefinition?.pbrMetallicRoughness?.baseColorTexture ||
            materialDefinition?.emissiveTexture ||
            materialDefinition?.pbrMetallicRoughness?.metallicRoughnessTexture ||
            materialDefinition?.normalTexture ||
            materialDefinition?.occlusionTexture) &&
          !geometry.features.uv
        )
          throw new Error('Textured primitive is missing TEXCOORD_0.');
        const vertices = geometry.bindings.map((binding) => {
          if (typeof binding.source !== 'number') {
            const buffer = uploadBuffer(
              this.device,
              resources,
              binding.source,
              GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
              'Repacked attributes',
            );
            if (deformation?.streams.some((stream) => stream.values === binding.source))
              uploads.push({ data: binding.source, buffer });
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
        const localCenter = vec3.scale(
          vec3.create(),
          vec3.add(vec3.create(), localMin, localMax),
          0.5,
        );
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
          for (const instance of batch) {
            const world = deformation?.skinned ? mat4.create() : instance.world;
            transforms.push(...world, ...(deformation?.skinned ? world : instance.normal));
            // Eight transformed AABB corners give conservative world-space framing bounds.
            for (let corner = 0; corner < 8; corner++) {
              const point = vec3.transformMat4(
                vec3.create(),
                [
                  corner & 1 ? localMax[0] : localMin[0],
                  corner & 2 ? localMax[1] : localMin[1],
                  corner & 4 ? localMax[2] : localMin[2],
                ],
                world,
              );
              vec3.min(min, min, point);
              vec3.max(max, max, point);
            }
          }
          const pipeline = await pipelines.get(
            pipelineArgs(geometry, material, deformation?.skinned ? false : batch[0].mirrored),
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
            center: deformation?.skinned
              ? vec3.clone(localCenter)
              : vec3.transformMat4(vec3.create(), localCenter, batch[0].world),
            depth: 0,
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
              uploads,
              normal: mat4.create(),
              localCenter: vec3.clone(localCenter),
              front: alternatives[0],
              mirrored: alternatives[1],
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
      transformData,
      transformBuffer: buffer,
      resources,
      instances: bindGroup,
      opaque,
      transparent,
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
    this.depth?.destroy();
    this.depth = this.device.createTexture({
      label: 'Viewport depth',
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private updatePose(scene: Scene): void {
    scene.pose.evaluate(this.clip, this.time);
    for (const update of scene.updates) {
      update.deformation?.update();
      for (const upload of update.uploads)
        this.device.queue.writeBuffer(
          upload.buffer,
          0,
          upload.data.buffer as ArrayBuffer,
          upload.data.byteOffset,
          upload.data.byteLength,
        );
      const world = scene.pose.nodes[update.node].world;
      if (update.deformation?.skinned) mat4.identity(update.normal);
      else {
        if (!mat4.invert(update.normal, world)) mat4.identity(update.normal);
        mat4.transpose(update.normal, update.normal);
      }
      const offset = update.draw.firstInstance * 32;
      scene.transformData.set(update.deformation?.skinned ? update.normal : world, offset);
      scene.transformData.set(update.normal, offset + 16);
      update.draw.pipeline =
        !update.deformation?.skinned && mat4.determinant(world) < 0
          ? update.mirrored
          : update.front;
      if (update.deformation) {
        const values = update.deformation.streams[0].values;
        for (let c = 0; c < 3; c++) {
          let min = Infinity,
            max = -Infinity;
          for (let v = c; v < values.length; v += 3) {
            min = Math.min(min, values[v]);
            max = Math.max(max, values[v]);
          }
          update.localCenter[c] = (min + max) * 0.5;
        }
      }
      if (update.deformation?.skinned) vec3.copy(update.draw.center, update.localCenter);
      else vec3.transformMat4(update.draw.center, update.localCenter, world);
    }
    if (scene.updates.length)
      this.device.queue.writeBuffer(
        scene.transformBuffer,
        0,
        scene.transformData.buffer as ArrayBuffer,
      );
    this.poseDirty = false;
  }

  private render = (timestamp: number): void => {
    if (this.disposed) return;
    const delta = this.lastTime ? (timestamp - this.lastTime) / 1000 : 0;
    this.lastTime = timestamp;
    if (this.scene) {
      const duration = this.animationState.duration;
      if (this.playing && this.clip >= 0 && duration > 0) {
        this.time = (this.time + delta) % duration;
        this.poseDirty = true;
      }
      if (this.poseDirty) {
        try {
          this.updatePose(this.scene);
          this.onAnimationChange?.();
        } catch (error) {
          this.stop();
          this.onError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
    }
    this.resize();
    this.frameData.set(this.camera.matrix(this.width / this.height));
    this.frameData.set(this.camera.eye, 16);
    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.025, g: 0.036, b: 0.052, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depth!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    const scene = this.scene;
    if (scene) {
      pass.setBindGroup(0, this.frameGroup);
      pass.setBindGroup(1, scene.instances);
      // Opaque rendering is deliberately organized by immutable state rather than the node tree.
      for (const [pipeline, materials] of scene.opaque) {
        pass.setPipeline(pipeline);
        for (const [material, draws] of materials) {
          pass.setBindGroup(2, material.bindGroup);
          for (const draw of draws) if (draw.pipeline === pipeline) this.draw(pass, draw);
        }
      }
      const forward = vec3.normalize(
        vec3.create(),
        vec3.subtract(vec3.create(), this.camera.target, this.camera.eye),
      );
      for (const draw of scene.transparent)
        draw.depth = vec3.dot(vec3.subtract(vec3.create(), draw.center, this.camera.eye), forward);
      scene.transparent.sort((a, b) => b.depth - a.depth);
      for (const draw of scene.transparent) {
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(2, draw.material.bindGroup);
        this.draw(pass, draw);
      }
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.animation = requestAnimationFrame(this.render);
  };

  private draw(pass: GPURenderPassEncoder, draw: Draw): void {
    draw.vertices.forEach((binding, slot) =>
      pass.setVertexBuffer(slot, binding.buffer, binding.offset),
    );
    if (draw.index) {
      pass.setIndexBuffer(draw.index, draw.indexFormat);
      pass.drawIndexed(draw.count, draw.instanceCount, 0, 0, draw.firstInstance);
    } else pass.draw(draw.count, draw.instanceCount, 0, draw.firstInstance);
  }
  private stop(): void {
    cancelAnimationFrame(this.animation);
  }
  destroy(): void {
    this.disposed = true;
    this.stop();
    this.scene?.resources.destroy();
    this.depth?.destroy();
    this.frameBuffer.destroy();
    this.camera.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
