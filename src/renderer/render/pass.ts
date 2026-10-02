import { vec3 } from 'gl-matrix';
import type { Scene, Draw } from '../scene/types';
import type { OutputPass } from '../presentation/output';
import type { CameraView } from '../../engine/camera/view';
import type { TransmissionBuffer } from './transmission';
import type { TransparencyPass } from './transparency';
import type { OcclusionCulling } from '../scene/occlusion';

export interface ScenePassContext {
  output: OutputPass;
  depth: GPUTexture;
  frameGroup: GPUBindGroup;
  environmentGroup: GPUBindGroup;
  camera: CameraView;
  transmission: TransmissionBuffer;
  transparency?: TransparencyPass;
  occlusion?: OcclusionCulling;
}

/** Submission consumes prepared buffers and visibility; no uploads or compute here. */
export function encodeScene(
  encoder: GPUCommandEncoder,
  scene: Scene | undefined,
  context: ScenePassContext,
): void {
  const { output, depth, frameGroup, environmentGroup, camera } = context;
  const hasTransmission = !!scene?.visibleTransmission.length;
  const hasWeighted = !!context.transparency && !!scene?.visibleTransparent.length;
  const begin = (load: boolean): GPURenderPassEncoder =>
    encoder.beginRenderPass({
      label: 'Scene rendering',
      colorAttachments: [
        // Resolve coverage in linear radiance, before the presentation pass tone maps it.
        output.sceneAttachment(
          { r: 0.001935, g: 0.002786, b: 0.004123, a: 1 },
          load ? 'load' : 'clear',
          (hasTransmission && !load) ||
            hasWeighted ||
            (!!context.occlusion?.ready && !!scene?.visibleTransparent.length),
        ),
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: load ? 'load' : 'clear',
        depthStoreOp:
          (hasTransmission && !load) || hasWeighted || context.occlusion?.ready
            ? 'store'
            : 'discard',
      },
    });
  let pass = begin(false);
  if (scene) {
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, scene.instances);
    pass.setBindGroup(3, environmentGroup);
    // Opaque rendering is deliberately organized by immutable state rather than the node tree.
    for (const [pipeline, materials] of scene.opaque) {
      pass.setPipeline(pipeline);
      for (const [material, draws] of materials) {
        pass.setBindGroup(2, material.bindGroup);
        for (const draw of draws)
          if (draw.pipeline === pipeline && draw.visibleRuns.length) submitDraw(pass, draw);
      }
    }
    if (context.occlusion?.ready) {
      pass.end();
      // Opaque/MASK depth is the only occluder source. Glass and BLEND must never
      // hide opaque geometry required by the transmission background snapshot.
      context.occlusion.encode(encoder, depth);
      if (!hasTransmission && (scene.visibleTransparent.length || hasWeighted)) {
        pass = begin(true);
        pass.setBindGroup(0, frameGroup);
        pass.setBindGroup(1, scene.instances);
        pass.setBindGroup(3, environmentGroup);
      } else if (!hasTransmission) return;
    }
    // Finish/resolve opaque rendering before taking the background snapshot. Store
    // MSAA samples and depth for the continuation pass so geometric coverage survives.
    if (hasTransmission) {
      if (!context.occlusion?.ready) pass.end();
      context.transmission.capture(encoder, output);
      pass = begin(true);
      pass.setBindGroup(0, context.transmission.group!);
      pass.setBindGroup(1, scene.instances);
      pass.setBindGroup(3, environmentGroup);
    }
    const forward = vec3.normalize(
      vec3.create(),
      vec3.fromValues(-camera.view[2], -camera.view[6], -camera.view[10]),
    );
    for (const list of hasWeighted
      ? [scene.visibleTransmission]
      : [scene.visibleTransmission, scene.visibleTransparent]) {
      for (const draw of list)
        draw.depth = vec3.dot(vec3.subtract(vec3.create(), draw.center, camera.eye), forward);
      list.sort((a, b) => b.depth - a.depth);
      for (const draw of list) {
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(2, draw.material.bindGroup);
        submitDraw(pass, draw);
      }
    }
    if (hasWeighted) {
      pass.end();
      // Test translucent fragments against opaque/transmission depth, but never let
      // them write depth. Accumulation/revealage are independent of submission order.
      pass = context.transparency!.begin(encoder, depth);
      pass.setBindGroup(0, hasTransmission ? context.transmission.group! : frameGroup);
      pass.setBindGroup(1, scene.instances);
      pass.setBindGroup(3, environmentGroup);
      for (const draw of scene.visibleTransparent) {
        pass.setPipeline(draw.pipeline);
        pass.setBindGroup(2, draw.material.bindGroup);
        submitDraw(pass, draw);
      }
      pass.end();
      context.transparency!.composite(encoder, output);
      return;
    }
  }
  pass.end();
}

function submitDraw(pass: GPURenderPassEncoder, draw: Draw): void {
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
