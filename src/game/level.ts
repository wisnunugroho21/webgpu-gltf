import { World } from '../engine/world';
import { AssetRegistry } from '../engine/assets/registry';
import type { PhysicsAdapter, Point3 } from '../engine/physics/contracts';
import { boxAsset, characterAsset } from './assets';
import { gameComponents, boxColliderComponent } from './components';

/** Level definitions drive both rendering and collision, preventing mismatched
 * invisible walls. Generated assets use the same registry as loaded glTF models. */
export function createLevel(physics: PhysicsAdapter, assets = new AssetRegistry()): World {
  const world = createLevelWorld(assets);
  installLevelCollisions(world, physics);
  return world;
}
/** CPU authoring content can be loaded/edited before choosing a physics backend. */
export function createLevelWorld(assets = new AssetRegistry()): World {
  assets.register('character', characterAsset(), 'generated:character');
  assets.register('box', boxAsset(), 'generated:box');
  const world = new World(assets, gameComponents());
  const boxes: { center: Point3; half: Point3 }[] = [
    { center: [0, -0.25, 0], half: [8, 0.25, 8] },
    { center: [0, 1, -8], half: [8, 1, 0.25] },
    { center: [0, 1, 8], half: [8, 1, 0.25] },
    { center: [-8, 1, 0], half: [0.25, 1, 8] },
    { center: [8, 1, 0], half: [0.25, 1, 8] },
    { center: [0, 0.5, -3], half: [1.5, 0.5, 0.5] },
    { center: [-3, 0.1, -1], half: [1, 0.1, 1] },
    { center: [-3, 0.2, -3], half: [1, 0.2, 1] },
  ];
  boxes.forEach(({ center, half }, i) => {
    world.createEntity({
      id: `level-${i}`,
      components: { 'game.colliderBox': { version: 1, halfExtents: [1, 1, 1] } },
      model: { asset: 'box' },
      transform: { translation: [...center], scale: [...half] },
    });
  });
  world.createEntity({
    id: 'player',
    transformOwner: 'physics',
    components: { 'game.actor': { version: 1, role: 'player' } },
    model: { asset: 'character' },
    transform: { translation: [0, 0.05, 3] },
  });
  addCompanion(world);
  world.update(0);
  return world;
}
export function addCompanion(world: World): void {
  world.createEntity({
    id: 'companion',
    components: { 'game.actor': { version: 1, role: 'companion' } },
    model: { asset: 'character' },
    transform: { translation: [2, 0.02, 3], rotation: [0, 0.7071068, 0, 0.7071068] },
  });
  world.getEntity('companion').model!.animation.select(1);
  world.getEntity('companion').model!.animation.setRootMotion({ node: 0, mode: 'in-place' });
}

/** Install once on a fresh backend, after scene/save selection. Collider geometry
 * comes from evaluated authored transforms, so edited saves do not recreate the
 * original level's collision at obsolete positions. Rotation/shear needs a future
 * backend shape extension; reject it instead of silently mismatching visuals. */
export function installLevelCollisions(
  world: World,
  physics: PhysicsAdapter,
  legacyBoxes = false,
): void {
  world.updateTransforms();
  const boxes: { center: Point3; half: Point3 }[] = [];
  for (const entity of world.entities) {
    const value = entity.getComponent('game.colliderBox');
    const authored = value === undefined ? undefined : boxColliderComponent(value);
    // Restore opts into legacy shapes only for older playground saves. New
    // authored worlds use explicit components, including intentional removal.
    const legacy =
      legacyBoxes && /^level-[0-7]$/.test(entity.id) && entity.model?.assetId === 'box';
    if (!authored && !legacy) continue;
    const m = entity.worldMatrix;
    if ([1, 2, 4, 6, 8, 9].some((index) => Math.abs(m[index]) > 1e-6))
      throw new Error(`Entity ${entity.id}: static-box physics requires axis-aligned transforms.`);
    const local = authored?.halfExtents ?? [1, 1, 1];
    const half = [
      Math.abs(m[0]) * local[0],
      Math.abs(m[5]) * local[1],
      Math.abs(m[10]) * local[2],
    ] as unknown as Point3;
    if (!half.every((extent) => extent > 0 && Number.isFinite(Math.fround(extent))))
      throw new Error(`Entity ${entity.id}: invalid static-box extents.`);
    boxes.push({ center: [m[12], m[13], m[14]], half });
  }
  // Validate every content shape before the first backend allocation. A backend
  // allocation failure still uses the session's existing complete teardown path.
  for (const { center, half } of boxes) physics.addBox(center, half);
}
