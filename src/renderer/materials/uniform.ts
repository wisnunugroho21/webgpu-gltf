import type { Material, TextureInfo } from '../../gltf/types';
import { textureCoordinates } from '../../gltf/texture-coordinates';
import { materialTextureSlots, materialFactorFloats, materialUniformByteSize } from './slots';

function number(
  value: number | undefined,
  fallback: number,
  name: string,
  min = 0,
  max = Infinity,
): number {
  const result = value ?? fallback;
  if (
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    !Number.isFinite(Math.fround(result))
  )
    throw new Error(`${name} must be finite and between ${min} and ${max}.`);
  return result;
}
function color(
  value: number[] | undefined,
  fallback: number[],
  name: string,
  max = Infinity,
): number[] {
  const result = value ?? fallback;
  if (result.length !== 3) throw new Error(`${name} must contain three components.`);
  return result.map((v) => number(v, 1, name, 0, max));
}
function authoredBasis(info?: TextureInfo): number {
  const uv = textureCoordinates(info);
  return Number(uv[0] === 1 && uv[1] === 0 && uv[3] === 0 && uv[4] === 0 && uv[5] === 1);
}

/** Pure CPU packing is shared by all materials. Extensions add data, never binding variants.
 * Eight factor vec4s precede twelve UV transforms, matching the WGSL Material struct. */
export function materialUniform(definition: Material): Float32Array {
  const alphaMode = definition.alphaMode ?? 'OPAQUE';
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(alphaMode))
    throw new Error('Invalid material alpha mode.');
  const pbr = definition.pbrMetallicRoughness ?? {};
  const ext = definition.extensions ?? {};
  const coat = ext.KHR_materials_clearcoat ?? {};
  const specular = ext.KHR_materials_specular ?? {};
  const transmission = ext.KHR_materials_transmission ?? {};
  const volume = ext.KHR_materials_volume ?? {};
  const values = new Float32Array(materialUniformByteSize / 4);
  materialTextureSlots.forEach((slot, i) =>
    values.set(textureCoordinates(slot.read(definition)), materialFactorFloats + i * 8),
  );
  values.set(pbr.baseColorFactor ?? [1, 1, 1, 1]);
  const strength = number(
    ext.KHR_materials_emissive_strength?.emissiveStrength,
    1,
    'Emissive strength',
  );
  values.set(
    color(definition.emissiveFactor, [0, 0, 0], 'Emissive factor').map((v) =>
      number(v * strength, 0, 'Scaled emission'),
    ),
    4,
  );
  values[7] = { OPAQUE: 0, MASK: 1, BLEND: 2 }[alphaMode];
  values.set(
    [
      pbr.metallicFactor ?? 1,
      pbr.roughnessFactor ?? 1,
      definition.alphaCutoff ?? 0.5,
      ext.KHR_materials_unlit ? 1 : 0,
    ],
    8,
  );
  values.set(
    [
      definition.normalTexture?.scale ?? 1,
      definition.occlusionTexture?.strength ?? 1,
      Number(!!definition.normalTexture),
      authoredBasis(definition.normalTexture),
    ],
    12,
  );
  values.set(
    [
      number(coat.clearcoatFactor, 0, 'Clearcoat factor', 0, 1),
      number(coat.clearcoatRoughnessFactor, 0, 'Clearcoat roughness', 0, 1),
      number(coat.clearcoatNormalTexture?.scale, 1, 'Clearcoat normal scale', -Infinity),
      Number(!!coat.clearcoatNormalTexture),
    ],
    16,
  );
  values.set(
    [
      ...color(specular.specularColorFactor, [1, 1, 1], 'Specular color'),
      number(specular.specularFactor, 1, 'Specular factor', 0, 1),
    ],
    20,
  );
  const ior = number(ext.KHR_materials_ior?.ior, 1.5, 'IOR');
  if (ior !== 0 && ior < 1) throw new Error('IOR must be zero or at least one.');
  // IOR zero is the specular-glossiness compatibility mode: infinite effective IOR.
  // Store zero as the sentinel; the shader handles it without infinity arithmetic.
  const distance = volume.attenuationDistance;
  if (distance !== undefined) number(distance, 1, 'Attenuation distance', Number.MIN_VALUE);
  const inverseDistance =
    distance === undefined ? 0 : number(1 / distance, 0, 'Inverse attenuation distance');
  values.set(
    [
      number(transmission.transmissionFactor, 0, 'Transmission factor', 0, 1),
      number(volume.thicknessFactor, 0, 'Thickness'),
      ior,
      inverseDistance,
    ],
    24,
  );
  values.set(
    [
      ...color(volume.attenuationColor, [1, 1, 1], 'Attenuation color', 1),
      authoredBasis(coat.clearcoatNormalTexture),
    ],
    28,
  );
  return values;
}
