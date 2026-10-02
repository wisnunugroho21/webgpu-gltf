import type { World } from '../world';
import type { ModelInstance } from '../model';

export interface WorldRenderSnapshot {
  readonly source: World;
  readonly structureRevision: number;
  readonly models: readonly { readonly entityId: string; readonly model: ModelInstance }[];
}

/** CPU rendering bridge: capture gameplay membership at the application's explicit
 * synchronization boundary. GPU code consumes model descriptors, not entity storage. */
export function captureWorldRenderSnapshot(world: World): WorldRenderSnapshot {
  return {
    source: world,
    structureRevision: world.structureRevision,
    models: world.entities.flatMap((entity) =>
      entity.model ? [{ entityId: entity.id, model: entity.model }] : [],
    ),
  };
}

export function validateWorldRenderSnapshot(snapshot: WorldRenderSnapshot): void {
  if (snapshot.source.structureRevision !== snapshot.structureRevision)
    throw new Error('World structure changed during preparation.');
}

/** Diff model identity rather than entity IDs or glTF node indices. A replacement
 * entity with a reused ID owns a new pose/output and is therefore an addition. */
export function planWorldMembership(
  snapshot: WorldRenderSnapshot,
  previous: readonly ModelInstance[],
) {
  const models = snapshot.models.map((descriptor) => descriptor.model);
  const next = new Set(models),
    old = new Set(previous);
  return {
    models,
    added: models.filter((model) => !old.has(model)),
    removed: previous.filter((model) => !next.has(model)),
  };
}
