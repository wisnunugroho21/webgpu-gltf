import type { World } from '../engine/world';
import type { ActionInput } from '../engine/input/actions';
import type { PhysicsAdapter, CharacterBody } from '../engine/physics/contracts';
import { writePhysicsPosition } from '../engine/physics/entity-pose';
import type { EngineSystem } from '../engine/systems/scheduler';
import { Locomotion, movement } from './locomotion';

/** Game policy depends on the adapter contract, never Rapier types. Gameplay
 * produces intent, physics resolves it and publishes the sole entity-root write.
 * Add other actors' movement before the shared step when expanding this slice. */
export class CharacterSimulation {
  readonly body: CharacterBody;
  readonly locomotion: Locomotion;
  readonly systems: readonly EngineSystem[];
  constructor(world: World, physics: PhysicsAdapter, input: ActionInput) {
    const player = world.getEntity('player');
    if (player.transformOwner !== 'physics' || !player.model)
      throw new Error('Player needs a model and a physics-owned root.');
    world.updateTransforms();
    const position = player.worldMatrix;
    this.body = physics.createCharacter([position[12], position[13], position[14]]);
    this.locomotion = new Locomotion(player.model!.animation);
    let intent = { x: 0, z: 0, jump: false };
    this.systems = [
      {
        id: 'character-intent',
        phase: 'gameplay',
        fixedUpdate: () => {
          intent = movement(input.consume());
          this.locomotion.update(Math.hypot(intent.x, intent.z));
          if (intent.x || intent.z) {
            const yaw = Math.atan2(intent.x, intent.z);
            // Animation controls limbs; this explicit override claims root facing.
            player.model!.setNodeOverride(0, {
              rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
            });
          }
        },
      },
      {
        id: 'character-physics',
        phase: 'physics',
        fixedUpdate: (_, step) => {
          this.body.move(intent, step.deltaSeconds);
          physics.step(step.deltaSeconds);
          world.updateTransforms();
          writePhysicsPosition(player, this.body.position, world.getParent(player.id));
        },
        destroy: () => this.destroy(),
      },
    ];
  }
  destroy(): void {
    this.body.destroy();
  }
}
