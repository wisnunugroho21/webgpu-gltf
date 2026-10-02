import type { Gltf } from '../types';
import { AssetBudget } from '../limits';
import { object, ref, integer, vector } from './fields';
import { supportedExtensions } from '../extensions';

export function validateMaterialMetadata(gltf: Gltf, budget: AssetBudget): void {
  for (const [i, image] of (gltf.images ?? []).entries())
    budget.at(`images[${i}]`, () => {
      if ((image.uri !== undefined) === (image.bufferView !== undefined))
        throw new Error('Image requires exactly one source.');
      if (image.uri !== undefined && typeof image.uri !== 'string')
        throw new Error('Invalid image URI.');
      if (image.bufferView !== undefined) {
        ref(image.bufferView, gltf.bufferViews);
        if (typeof image.mimeType !== 'string')
          throw new Error('Embedded image requires MIME type.');
      }
    });
  for (const [i, texture] of (gltf.textures ?? []).entries())
    budget.at(`textures[${i}]`, () => {
      if (texture.source !== undefined) ref(texture.source, gltf.images);
      if (texture.sampler !== undefined) ref(texture.sampler, gltf.samplers);
      const basis = texture.extensions?.KHR_texture_basisu;
      if (basis) {
        object(basis);
        ref(basis.source, gltf.images);
      }
      if (texture.source === undefined && !basis)
        throw new Error('Texture requires an image source.');
    });
  for (const [i, material] of (gltf.materials ?? []).entries())
    budget.at(`materials[${i}]`, () => {
      // Only walk supported material fields. Extension payloads may be nested; an explicit stack
      // avoids consuming the JS call stack on malformed authoring metadata.
      if (material.pbrMetallicRoughness !== undefined) object(material.pbrMetallicRoughness);
      if (material.extensions !== undefined) object(material.extensions);
      if (material.doubleSided !== undefined && typeof material.doubleSided !== 'boolean')
        throw new Error('Invalid doubleSided flag.');
      if (
        material.alphaMode !== undefined &&
        !['OPAQUE', 'MASK', 'BLEND'].includes(material.alphaMode)
      )
        throw new Error('Invalid alphaMode.');
      const numeric = new Set([
        'metallicFactor',
        'roughnessFactor',
        'alphaCutoff',
        'strength',
        'emissiveStrength',
        'ior',
        'specularFactor',
        'clearcoatFactor',
        'clearcoatRoughnessFactor',
        'transmissionFactor',
        'thicknessFactor',
        'attenuationDistance',
        'rotation',
      ]);
      const vectors: Record<string, number> = {
        baseColorFactor: 4,
        emissiveFactor: 3,
        specularColorFactor: 3,
        attenuationColor: 3,
        offset: 2,
      };
      const pending: { value: unknown; key: string }[] = [{ value: material, key: '' }];
      while (pending.length) {
        const { value, key } = pending.pop()!;
        if (numeric.has(key) && (typeof value !== 'number' || !Number.isFinite(value)))
          throw new Error(`Expected finite ${key}.`);
        if (Object.hasOwn(vectors, key)) vector(value, vectors[key]);
        if (key === 'texCoord') integer(value);
        if (key === 'scale') {
          if (Array.isArray(value)) vector(value, 2);
          else if (typeof value !== 'number' || !Number.isFinite(value))
            throw new Error('Expected finite texture scale.');
        }
        if (key.endsWith('Texture')) {
          object(value);
          ref(value.index, gltf.textures);
        }
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new Error(`Non-finite ${key}.`);
        if (!value || typeof value !== 'object') continue;
        for (const [name, item] of Object.entries(value)) {
          if (
            name === 'extras' ||
            (name.startsWith('KHR_') && !(supportedExtensions as readonly string[]).includes(name))
          )
            continue;
          if (name === 'extensions') object(item);
          pending.push({ value: item, key: name });
        }
      }
    });
}
