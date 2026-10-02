import type { Gltf } from './types';
import { components } from './accessors';
import { AssetBudget, checkLimit } from './limits';
import { array, object, integer, ref } from './validation/fields';
import { validateAccessorMetadata } from './validation/accessors';
import { validateSceneMetadata } from './validation/scene';
import { validateMaterialMetadata } from './validation/materials';
import { validateAnimationMetadata } from './validation/animations';
export { validatePayload } from './validation/payload';

const tables = [
  'buffers',
  'bufferViews',
  'accessors',
  'meshes',
  'nodes',
  'scenes',
  'materials',
  'textures',
  'images',
  'samplers',
  'skins',
  'animations',
] as const;

/** Validate the JSON structures used by this implementation before dependency fetch
 * or decoder allocation. This is a bounded runtime contract, not full conformance. */
export function validateMetadata(value: unknown, budget: AssetBudget): asserts value is Gltf {
  budget.at('$', () => object(value));
  const gltf = value as Gltf;
  budget.at('asset', () => {
    object(gltf.asset);
    if (gltf.asset.version !== '2.0' || (gltf.asset.minVersion && gltf.asset.minVersion !== '2.0'))
      throw new Error('Only glTF 2.0 is supported.');
  });
  for (const name of tables) {
    const list = gltf[name];
    if (list === undefined) continue;
    budget.at(name, () => {
      array(list);
      checkLimit(
        list.length,
        name === 'nodes' ? budget.limits.maxNodes : budget.limits.maxDefinitions,
        name,
      );
    });
    for (const [i, item] of list.entries()) budget.at(`${name}[${i}]`, () => object(item));
  }
  for (const name of ['extensionsRequired', 'extensionsUsed'] as const)
    if (gltf[name] !== undefined)
      budget.at(name, () => {
        array(gltf[name]);
        if (gltf[name]!.some((v) => typeof v !== 'string'))
          throw new Error('Expected extension names.');
      });
  let declared = 0;
  for (const [i, buffer] of (gltf.buffers ?? []).entries())
    budget.at(`buffers[${i}]`, () => {
      integer(buffer.byteLength, 1);
      checkLimit(buffer.byteLength, budget.limits.maxDecodedBufferBytes, 'buffer byteLength');
      declared += buffer.byteLength;
      if (buffer.uri !== undefined && typeof buffer.uri !== 'string')
        throw new Error('Expected URI string.');
    });
  budget.at('buffers', () =>
    checkLimit(declared, budget.limits.maxDecodedBufferBytes, 'declared buffer bytes'),
  );
  for (const [i, view] of (gltf.bufferViews ?? []).entries())
    budget.at(`bufferView ${i}`, () => {
      ref(view.buffer, gltf.buffers);
      integer(view.byteOffset ?? 0);
      integer(view.byteLength, 1);
      checkLimit(view.byteLength, budget.limits.maxDecodedBufferBytes, 'bufferView byteLength');
      if (view.byteStride !== undefined) {
        integer(view.byteStride, 4);
        if (view.byteStride > 252 || view.byteStride % 4)
          throw new Error('Invalid bufferView stride.');
      }
      const ext = view.extensions?.EXT_meshopt_compression;
      if (ext) {
        object(ext);
        ref(ext.buffer, gltf.buffers);
        integer(ext.byteOffset ?? 0);
        integer(ext.byteLength, 1);
        integer(ext.count, 1);
        integer(ext.byteStride, 1);
        if (
          !['ATTRIBUTES', 'TRIANGLES', 'INDICES'].includes(ext.mode) ||
          !['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL'].includes(ext.filter ?? 'NONE')
        )
          throw new Error('Invalid meshopt mode or filter.');
        if ((ext.byteOffset ?? 0) + ext.byteLength > gltf.buffers![ext.buffer].byteLength)
          throw new Error('Meshopt source exceeds declared buffer.');
        if (ext.count * ext.byteStride !== view.byteLength)
          throw new Error('Invalid meshopt decoded size.');
        checkLimit(
          ext.count * ext.byteStride,
          budget.limits.maxDecodedBufferBytes,
          'meshopt decoded bytes',
        );
      } else if ((view.byteOffset ?? 0) + view.byteLength > gltf.buffers![view.buffer].byteLength)
        throw new Error('bufferView exceeds declared buffer.');
    });
  let values = 0;
  for (const [i, accessor] of (gltf.accessors ?? []).entries())
    budget.at(`accessors[${i}]`, () => {
      validateAccessorMetadata(gltf, accessor);
      const count = accessor.count * components[accessor.type];
      checkLimit(count, budget.limits.maxAccessorValues, 'accessor values');
      values += count;
    });
  budget.at('accessors', () =>
    checkLimit(values, budget.limits.maxTotalAccessorValues, 'total accessor values'),
  );
  values += validateSceneMetadata(gltf, budget);
  budget.at('meshes', () =>
    checkLimit(
      values,
      budget.limits.maxTotalAccessorValues,
      'accessor and expanded geometry values',
    ),
  );
  validateMaterialMetadata(gltf, budget);
  validateAnimationMetadata(gltf, budget, values);
}
