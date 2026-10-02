import type { World } from '../engine/world';
import type { ActionInput } from '../engine/input/actions';
import type {
  CheckpointPhysicsAdapter,
  CheckpointCharacterBody,
} from '../engine/physics/contracts';
import { writePhysicsPosition } from '../engine/physics/entity-pose';
import type { EngineSystem } from '../engine/systems/scheduler';
import { Locomotion, movement } from './locomotion';

/** Game policy depends on the adapter contract, never Rapier types. Gameplay
 * produces intent, physics resolves it and publishes the sole entity-root write.
 * Add other actors' movement before the shared step when expanding this slice. */
export class CharacterSimulation {
  readonly body: CheckpointCharacterBody;
  readonly locomotion: Locomotion;
  readonly systems: readonly EngineSystem[];
  rootMotionEnabled = false;
  footfalls = 0;
  private aim = false;
  private extracting = false;
  private disposed = false;
  /** Reconnect game policy to a restored controller before the next input step. */
  restorePolicy(): void {
    const animation = this.locomotionAnimation;
    this.aim = animation.state.overlays.some((layer) => layer.clip === 3 && layer.weight > 0);
    this.extracting = animation.checkpoint().rootMotion?.mode === 'extract';
  }
  private locomotionAnimation;
  constructor(world: World, physics: CheckpointPhysicsAdapter, input: ActionInput) {
    const player = world.getEntity('player');
    if (player.transformOwner !== 'physics' || !player.model)
      throw new Error('Player needs a model and a physics-owned root.');
    world.updateTransforms();
    const position = player.worldMatrix;
    this.body = physics.createCharacter([position[12], position[13], position[14]]);
    this.locomotion = new Locomotion(player.model!.animation);
    const animation = player.model!.animation;
    this.locomotionAnimation = animation;
    animation.setClock('external');
    animation.setRootMotion({ node: 0, mode: 'in-place' });
    let intent = { x: 0, z: 0, jump: false };
    this.systems = [
      {
        id: 'character-intent',
        phase: 'gameplay',
        fixedUpdate: (_, step) => {
          const actions = input.consume();
          intent = movement(actions);
          this.locomotion.update(Math.hypot(intent.x, intent.z));
          if (this.extracting !== this.rootMotionEnabled) {
            this.extracting = this.rootMotionEnabled;
            animation.setRootMotion({ node: 0, mode: this.extracting ? 'extract' : 'in-place' });
          }
          const nextAim = actions.get('aim')?.held ?? false;
          if (this.aim !== nextAim) {
            this.aim = nextAim;
            animation.setOverlays(
              this.aim
                ? [{ clip: 3, time: 0.5, speed: 0, weight: 1, additive: true, mask: [3, 4] }]
                : [],
            );
          }
          animation.advance(step.deltaSeconds);
          this.footfalls += animation
            .drainEvents()
            .filter((event) => event.name.startsWith('foot-')).length;
          const displacement = animation.consumeRootMotion();
          if (this.extracting) {
            const length = Math.hypot(intent.x, intent.z);
            const speed = Math.hypot(displacement[0], displacement[2]) / step.deltaSeconds;
            if (length > 0) {
              intent.x *= speed / length;
              intent.z *= speed / length;
            } else {
              intent.x = 0;
              intent.z = 0;
            }
          }
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
    if (this.disposed) return;
    this.disposed = true;
    this.body.destroy();
  }
}
