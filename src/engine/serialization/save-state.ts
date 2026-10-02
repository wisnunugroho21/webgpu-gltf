import { copyJson, type JsonValue } from './json';
import { parseSceneDocument, type SceneDocument } from '../scene-document';
import { loadWorld, type LoadWorldOptions } from '../load-world';
import type { World } from '../world';
import type { EngineRuntime, RuntimeCheckpoint } from '../runtime/runtime';
import { validateRuntimeCheckpoint } from '../runtime/runtime';
import type { AnimationCheckpoint } from '../../animation/controller';
import type { TransformData } from '../../scene/transform';

export interface SaveState {
  kind: 'engine-save';
  version: 1;
  /** A flattened runtime snapshot. Keep the source authoring scene separately. */
  scene: SceneDocument;
  models: Record<
    string,
    { animation: AnimationCheckpoint; overrides: Record<string, Partial<TransformData>> }
  >;
  runtime?: RuntimeCheckpoint;
  /** Backend/game-specific state such as physics velocity, quests and random seeds. */
  gameplay: JsonValue;
}
export function captureSaveState(
  world: World,
  runtime?: EngineRuntime,
  gameplay: JsonValue = null,
): SaveState {
  if (runtime && runtime.world !== world) throw new Error('Save runtime belongs to another world.');
  return {
    kind: 'engine-save',
    version: 1,
    scene: world.toDocument(),
    models: Object.fromEntries(
      world.entities
        .filter((entity) => entity.model)
        .map((entity) => [
          entity.id,
          {
            animation: entity.model!.animation.checkpoint(),
            overrides: Object.fromEntries(
              entity
                .model!.pose.nodes.map((_, node) => [
                  String(node),
                  entity.model!.getNodeOverride(node),
                ])
                .filter(([, override]) => Object.keys(override).length),
            ),
          },
        ]),
    ),
    ...(runtime ? { runtime: runtime.checkpoint() } : {}),
    gameplay: copyJson(gameplay),
  };
}

/** Construct privately, validate saved per-instance data, then publish. Callers
 * recreate their systems/physics from gameplay and restore the runtime checkpoint.
 * Failed restoration never mutates an existing world or renderer attachment. */
export async function loadSaveState(
  value: unknown,
  options: LoadWorldOptions = {},
): Promise<{ world: World; runtime?: RuntimeCheckpoint; gameplay: JsonValue }> {
  const state = copyJson(
    typeof value === 'string' ? JSON.parse(value) : (value as JsonValue),
  ) as unknown as SaveState;
  if (
    !state ||
    state.kind !== 'engine-save' ||
    state.version !== 1 ||
    Object.keys(state).some(
      (key) => !['kind', 'version', 'scene', 'models', 'runtime', 'gameplay'].includes(key),
    ) ||
    !state.models ||
    typeof state.models !== 'object' ||
    Array.isArray(state.models) ||
    state.gameplay === undefined
  )
    throw new Error('Invalid engine save state.');
  parseSceneDocument(state.scene, options.components);
  if (state.runtime) validateRuntimeCheckpoint(state.runtime);
  const world = await loadWorld(state.scene, undefined, options);
  try {
    const entities = world.entities.filter((entity) => entity.model);
    if (
      Object.keys(state.models).length !== entities.length ||
      entities.some((entity) => !Object.hasOwn(state.models, entity.id))
    )
      throw new Error('Saved model instances do not match the scene.');
    for (const entity of entities) {
      const saved = state.models[entity.id];
      if (Object.keys(saved).some((key) => !['animation', 'overrides'].includes(key)))
        throw new Error('Unknown saved model field.');
      entity.model!.animation.restore(saved.animation);
      for (const [node, override] of Object.entries(saved.overrides)) {
        if (String(Number(node)) !== node) throw new Error('Invalid saved override node.');
        entity.model!.setNodeOverride(Number(node), override);
      }
    }
    world.update(state.runtime ? state.runtime.simulationTimeMs + state.runtime.accumulatorMs : 0);
    return { world, runtime: state.runtime, gameplay: state.gameplay };
  } catch (error) {
    if (!options.assets) world.models.destroy();
    throw error;
  }
}
