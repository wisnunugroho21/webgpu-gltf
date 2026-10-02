import RAPIER from '@dimforge/rapier3d-compat';
import type { CharacterBody, CharacterMotion, PhysicsAdapter, Point3 } from './contracts';

let initialization: Promise<void> | undefined;
/** Optional backend module: import directly to avoid pulling WASM into the viewer. */
export class RapierPhysics implements PhysicsAdapter {
  private world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  private disposed = false;
  static async create(): Promise<RapierPhysics> {
    initialization ??= RAPIER.init().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
    await initialization;
    return new RapierPhysics();
  }
  private constructor() {}
  private assertLive(): void {
    if (this.disposed) throw new Error('Physics adapter is disposed.');
  }
  addBox(center: Point3, halfExtents: Point3): void {
    this.assertLive();
    if (!center.every(Number.isFinite) || !halfExtents.every((v) => Number.isFinite(v) && v > 0))
      throw new Error('Invalid box shape.');
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(...halfExtents).setTranslation(...center));
  }
  createCharacter(feet: Point3): CharacterBody {
    this.assertLive();
    if (!feet.every(Number.isFinite)) throw new Error('Invalid character position.');
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(feet[0], feet[1] + 0.9, feet[2]),
    );
    const collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.35), body);
    const controller = this.world.createCharacterController(0.01);
    controller.enableAutostep(0.3, 0.2, false);
    controller.enableSnapToGround(0.2);
    controller.setMaxSlopeClimbAngle(Math.PI / 4);
    let vertical = 0,
      grounded = false,
      removed = false;
    const live = () => {
      this.assertLive();
      if (removed) throw new Error('Character is disposed.');
    };
    return {
      checkpoint: () => {
        live();
        const p = body.translation();
        return { position: [p.x, p.y - 0.9, p.z], verticalVelocity: vertical, grounded };
      },
      restore: (state) => {
        live();
        if (
          state.position.length !== 3 ||
          !state.position.every(Number.isFinite) ||
          !Number.isFinite(state.verticalVelocity) ||
          typeof state.grounded !== 'boolean'
        )
          throw new Error('Invalid character checkpoint.');
        const p = { x: state.position[0], y: state.position[1] + 0.9, z: state.position[2] };
        body.setTranslation(p, true);
        body.setNextKinematicTranslation(p);
        vertical = state.verticalVelocity;
        grounded = state.grounded;
      },
      get position(): Point3 {
        live();
        const p = body.translation();
        return [p.x, p.y - 0.9, p.z];
      },
      get grounded() {
        live();
        return grounded;
      },
      move: (motion: CharacterMotion, dt: number) => {
        live();
        if (!(dt > 0 && Number.isFinite(dt)) || ![motion.x, motion.z].every(Number.isFinite))
          throw new Error('Invalid character motion.');
        if (motion.jump && grounded) vertical = 5;
        vertical -= 9.81 * dt;
        controller.computeColliderMovement(collider, {
          x: motion.x * dt,
          y: vertical * dt,
          z: motion.z * dt,
        });
        const movement = controller.computedMovement();
        grounded = controller.computedGrounded();
        if (grounded && vertical < 0) vertical = 0;
        if (vertical > 0 && movement.y < vertical * dt - 1e-5) vertical = 0;
        const p = body.translation();
        body.setNextKinematicTranslation({
          x: p.x + movement.x,
          y: p.y + movement.y,
          z: p.z + movement.z,
        });
      },
      destroy: () => {
        if (removed || this.disposed) return;
        removed = true;
        this.world.removeCharacterController(controller);
        this.world.removeRigidBody(body);
      },
    };
  }
  step(dt: number): void {
    this.assertLive();
    if (!(dt > 0 && Number.isFinite(dt))) throw new Error('Invalid physics timestep.');
    this.world.timestep = dt;
    this.world.step();
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.free();
  }
}
