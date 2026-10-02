export type Point3 = readonly [number, number, number];
export interface CharacterMotion {
  x: number;
  z: number;
  jump: boolean;
}
export interface CharacterBody {
  readonly position: Point3;
  readonly grounded: boolean;
  move(motion: CharacterMotion, deltaSeconds: number): void;
  destroy(): void;
}
/** Backend owns collision queries and integration; engine owns scheduling. Shapes
 * are world-space meters. Character position denotes its feet, not capsule center. */
export interface PhysicsAdapter {
  addBox(center: Point3, halfExtents: Point3): void;
  createCharacter(feet: Point3): CharacterBody;
  step(deltaSeconds: number): void;
  destroy(): void;
}
