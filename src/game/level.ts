import { World } from '../engine/world';
import { AssetRegistry } from '../engine/assets/registry';
import type { PhysicsAdapter, Point3 } from '../engine/physics/contracts';
import { boxAsset, characterAsset } from './assets';

/** Level definitions drive both rendering and collision, preventing mismatched
 * invisible walls. Generated assets use the same registry as loaded glTF models. */
export function createLevel(physics: PhysicsAdapter, assets = new AssetRegistry()): World {
  assets.register('character', characterAsset(), 'generated:character');
  assets.register('box', boxAsset(), 'generated:box');
  const world = new World(assets);
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
    physics.addBox(center, half);
    world.createEntity({
      id: `level-${i}`,
      model: { asset: 'box' },
      transform: { translation: [...center], scale: [...half] },
    });
  });
  world.createEntity({
    id: 'player',
    transformOwner: 'physics',
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
    model: { asset: 'character' },
    transform: { translation: [2, 0.02, 3], rotation: [0, 0.7071068, 0, 0.7071068] },
  });
  world.getEntity('companion').model!.animation.select(1);
  world.getEntity('companion').model!.animation.setRootMotion({ node: 0, mode: 'in-place' });
}
