import type { Renderer } from '../../src/renderer/renderer';
import type { Scene } from '../../src/renderer/scene/types';

const identities = new WeakMap<object, Readonly<{ id: number }>>();
let nextIdentity = 0;
function identity(resource: object): Readonly<{ id: number }> {
  let token = identities.get(resource);
  if (!token) {
    token = Object.freeze({ id: nextIdentity++ });
    identities.set(resource, token);
  }
  return token;
}

/** Test-only boundary for private state. Snapshots copy CPU values and expose GPU
 * identity tokens for comparison, never live GPU objects, mutable arrays or setters.
 * Keep this helper out of public engine exports and production modules. */
export function inspectRenderer(renderer: Renderer) {
  const scene = Reflect.get(renderer, 'scene') as Scene | undefined;
  return Object.freeze({
    stats: Object.freeze({ ...renderer.frameStats }),
    scene: scene
      ? Object.freeze({
          stats: Object.freeze({ ...scene.stats }),
          transformBytes: scene.transformData.byteLength,
          transformBuffer: identity(scene.transformBuffer),
          updateNodes: Object.freeze(scene.updates.map((update) => update.node)),
          nodes: Object.freeze(
            scene.pose.nodes.map((node) =>
              Object.freeze({
                world: Object.freeze(Array.from(node.world)),
                worldRevision: node.worldRevision,
                weightsRevision: node.weightsRevision,
              }),
            ),
          ),
          draws: Object.freeze(
            scene.draws.map((draw) =>
              Object.freeze({
                pipeline: identity(draw.pipeline),
                material: identity(draw.material.bindGroup),
                firstInstance: draw.firstInstance,
                instanceCount: draw.instanceCount,
                visibleRuns: Object.freeze([...draw.visibleRuns]),
                vertices: Object.freeze(
                  draw.vertices.map((vertex) =>
                    Object.freeze({ buffer: identity(vertex.buffer), offset: vertex.offset }),
                  ),
                ),
              }),
            ),
          ),
        })
      : undefined,
  });
}

/** Explicit instrumentation access for GPU allocation/timing tests, distinct from
 * read-only scene inspection. Browser tests already depend on this private device. */
export function testDevice(renderer: Renderer): GPUDevice {
  const device: unknown = Reflect.get(renderer, 'device');
  if (!(device instanceof GPUDevice)) throw new Error('Renderer test device is unavailable.');
  return device;
}
