import { loadSaveState } from '../engine/serialization/save-state';
import type { World } from '../engine/world';
import type { CharacterSimulation } from './simulation';

/** Storage can be blocked even when WebGPU works. Failure to consume a pending
 * save is an optional-tool failure and must not prevent a fresh session. */
export function readPendingSave(
  report: (message: string) => void,
  storage: () => Pick<Storage, 'getItem' | 'removeItem'> = () => sessionStorage,
): string | undefined {
  try {
    const store = storage();
    const pending = store.getItem('engine-game-pending');
    if (pending !== null) store.removeItem('engine-game-pending');
    return pending ?? undefined;
  } catch (error) {
    report(`Restore unavailable: ${String(error)} Starting a new game.`);
    return undefined;
  }
}

/** Capture the restored player controller before constructing gameplay systems:
 * their constructors establish defaults that must not overwrite the save. */
export async function restoreGameWorld(value: string, initial: World) {
  const restored = await loadSaveState(value, {
    assets: initial.models,
    components: initial.components,
  });
  const playerAnimation = restored.world.getEntity('player').model?.animation.checkpoint();
  if (!playerAnimation) throw new Error('Saved player requires a model.');
  // Older playground saves had neither actor nor collider metadata. Keep this
  // compatibility decision in the game restore adapter, not generic editor data.
  const legacyBoxes = restored.world.entities.every(
    (entity) =>
      entity.getComponent('game.actor') === undefined &&
      entity.getComponent('game.colliderBox') === undefined,
  );
  return { ...restored, playerAnimation, legacyBoxes };
}
export type GameRestore = Awaited<ReturnType<typeof restoreGameWorld>>;

export function restoreCharacter(
  simulation: CharacterSimulation,
  world: World,
  saved: GameRestore,
): void {
  const gameplay = saved.gameplay as unknown as {
    body: ReturnType<NonNullable<typeof simulation.body.checkpoint>>;
    footfalls: number;
    rootMotion: boolean;
    locomotion: 'Idle' | 'Walk' | 'Run';
  };
  if (
    !gameplay ||
    !Number.isSafeInteger(gameplay.footfalls) ||
    gameplay.footfalls < 0 ||
    typeof gameplay.rootMotion !== 'boolean' ||
    !['Idle', 'Walk', 'Run'].includes(gameplay.locomotion)
  )
    throw new Error('Invalid saved character gameplay.');
  simulation.body.restore(gameplay.body);
  simulation.footfalls = gameplay.footfalls;
  simulation.rootMotionEnabled = gameplay.rootMotion;
  simulation.locomotion.state = gameplay.locomotion;
  world.getEntity('player').model!.animation.restore(saved.playerAnimation);
  simulation.restorePolicy();
}
