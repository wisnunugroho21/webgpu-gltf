import { vec3 } from 'gl-matrix';
import type { Scene, Draw } from '../scene/types';
import type { OutputPass } from '../presentation/output';
import type { OrbitCamera } from '../camera/orbit-camera';

export interface ScenePassContext {
  output: OutputPass;
  depth: GPUTexture;
  frameGroup: GPUBindGroup;
  environmentGroup: GPUBindGroup;
  camera: OrbitCamera;
}

/** Submission consumes prepared buffers and visibility; no uploads or compute here. */
export function encodeScene(
  encoder: GPUCommandEncoder,
  scene: Scene | undefined,
  context: ScenePassContext,
): void {
  const { output, depth, frameGroup, environmentGroup, camera } = context;
  const pass = encoder.beginRenderPass({
    label: 'Scene rendering',
    colorAttachments: [
      // Resolve coverage in linear radiance, before the presentation pass tone maps it.
      output.sceneAttachment({ r: 0.001935, g: 0.002786, b: 0.004123, a: 1 }),
    ],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'discard',
    },
  });
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
    const forward = vec3.normalize(
      vec3.create(),
      vec3.subtract(vec3.create(), camera.target, camera.eye),
    );
    for (const draw of scene.visibleTransparent)
      draw.depth = vec3.dot(vec3.subtract(vec3.create(), draw.center, camera.eye), forward);
    scene.visibleTransparent.sort((a, b) => b.depth - a.depth);
    for (const draw of scene.visibleTransparent) {
      pass.setPipeline(draw.pipeline);
      pass.setBindGroup(2, draw.material.bindGroup);
      submitDraw(pass, draw);
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
