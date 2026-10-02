import type { World } from './world';
/** Copy-only tooling boundary. Inspectors never mutate borrowed poses or GPU objects;
 * edits use Entity.setTransform/setComponent and explicit model overrides. */
export function inspectWorld(world: World) {
  return {
    structureRevision: world.structureRevision,
    hierarchyRevision: world.hierarchyRevision,
    poseRevision: world.poseRevision,
    hierarchy: world.hierarchyStats,
    timings: world.cpuTimings,
    assets: Object.keys(world.models.references()).map((id) => world.models.inspect(id)),
    entities: world.entities.map((entity) => ({
      ...entity.definition(world.getParent(entity.id)?.id),
      worldMatrix: Array.from(entity.worldMatrix),
      localRevision: entity.localRevision,
      worldRevision: entity.worldRevision,
      modelState: entity.model
        ? {
            nodeCount: entity.model.pose.nodes.length,
            poseRevision: entity.model.pose.revision,
            animation: entity.model.animation.state,
          }
        : undefined,
    })),
  };
}
