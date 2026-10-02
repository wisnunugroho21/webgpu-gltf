import type { Asset } from '../types';
import { AssetBudget } from '../limits';
import { inspectAccessor } from '../accessors';
import { prepareClips } from '../../animation/tracks';

/** Scan raw components without allocating accessor arrays. Only animation preparation
 * needs packed keys; its metadata counts have already passed the CPU budgets. */
export function validatePayload(asset: Asset, budget: AssetBudget): void {
  for (const [i, accessor] of (asset.gltf.accessors ?? []).entries()) {
    // Draco appends replacements; its original declaration may intentionally lack data.
    if (accessor.bufferView === undefined && !accessor.sparse) continue;
    budget.at(`accessors[${i}]`, () => inspectAccessor(asset, accessor));
  }
  for (const [mi, mesh] of (asset.gltf.meshes ?? []).entries())
    for (const [pi, primitive] of mesh.primitives.entries())
      budget.at(`meshes[${mi}].primitives[${pi}]`, () => {
        for (const index of [
          ...Object.values(primitive.attributes),
          ...(primitive.targets ?? []).flatMap((target) => Object.values(target)),
        ]) {
          const accessor = asset.gltf.accessors![index];
          if (accessor.bufferView === undefined && !accessor.sparse)
            throw new Error('Attribute has no decoded source.');
        }
        if (primitive.indices !== undefined)
          inspectAccessor(asset, asset.gltf.accessors![primitive.indices], (value) => {
            if (value >= asset.gltf.accessors![primitive.attributes.POSITION].count)
              throw new Error('Index exceeds vertex count.');
          });
      });
  const palettes = new Map<number, number>();
  for (const node of asset.gltf.nodes ?? [])
    if (node.skin !== undefined && node.mesh !== undefined)
      palettes.set(
        node.mesh,
        Math.min(palettes.get(node.mesh) ?? Infinity, asset.gltf.skins![node.skin].joints.length),
      );
  for (const [meshIndex, palette] of palettes)
    for (const [pi, primitive] of asset.gltf.meshes![meshIndex].primitives.entries())
      budget.at(`meshes[${meshIndex}].primitives[${pi}].skin`, () => {
        if (primitive.attributes.JOINTS_0 === undefined)
          throw new Error('Skinned primitive requires JOINTS_0 and WEIGHTS_0.');
        const count = asset.gltf.accessors![primitive.attributes.POSITION].count;
        const sums = new Float64Array(count);
        for (const [name, index] of Object.entries(primitive.attributes))
          if (/^JOINTS_/.test(name)) {
            inspectAccessor(asset, asset.gltf.accessors![index], (value) => {
              if (value >= palette) throw new Error('Joint index exceeds skin palette.');
            });
            const weights =
              asset.gltf.accessors![primitive.attributes[name.replace('JOINTS', 'WEIGHTS')]];
            inspectAccessor(asset, weights, (value, index) => {
              if (value < 0) throw new Error('Negative skin weight.');
              sums[Math.floor(index / 4)] += value;
            });
          }
        if (sums.some((value) => value <= 0))
          throw new Error('Skin vertex has no positive joint weights.');
      });
  for (const [i, animation] of (asset.gltf.animations ?? []).entries())
    budget.at(`animations[${i}]`, () =>
      prepareClips({ ...asset, gltf: { ...asset.gltf, animations: [animation] } }),
    );
}
