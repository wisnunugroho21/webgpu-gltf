import { expect, test } from 'vitest';
import type { Material } from '../src/gltf/types';
import { materialUniform } from '../src/renderer/materials/uniform';
import { materialTextureSlots } from '../src/renderer/materials/slots';
import { supportedExtensions } from '../src/gltf/extensions';

test('extension defaults retain core shading and pack the shared 512-byte uniform', () => {
  const base = materialUniform({});
  const defaults = materialUniform({
    extensions: {
      KHR_materials_clearcoat: {},
      KHR_materials_ior: {},
      KHR_materials_specular: {},
      KHR_materials_transmission: {},
      KHR_materials_volume: {},
      KHR_materials_emissive_strength: {},
    },
  });
  expect(defaults).toEqual(base);
  expect(base.byteLength).toBe(512);
  expect([...base.slice(16, 32)]).toEqual([0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1.5, 0, 1, 1, 1, 1]);
  expect(supportedExtensions).toContain('KHR_materials_volume');
});

test('packs HDR emission, independent coat/specular parameters, IOR and inverse attenuation distance', () => {
  const values = materialUniform({
    emissiveFactor: [0.5, 0.25, 1],
    extensions: {
      KHR_materials_emissive_strength: { emissiveStrength: 4 },
      KHR_materials_clearcoat: { clearcoatFactor: 0.5, clearcoatRoughnessFactor: 0.25 },
      KHR_materials_specular: { specularColorFactor: [2, 1, 0.5], specularFactor: 0.75 },
      KHR_materials_ior: { ior: 0 },
      KHR_materials_transmission: { transmissionFactor: 0.8 },
      KHR_materials_volume: {
        thicknessFactor: 2,
        attenuationDistance: 4,
        attenuationColor: [0, 0.5, 1],
      },
    },
  });
  expect([...values.slice(4, 7)]).toEqual([2, 1, 4]);
  expect([...values.slice(16, 24)]).toEqual([0.5, 0.25, 1, 0, 2, 1, 0.5, 0.75]);
  expect(values[24]).toBeCloseTo(0.8);
  expect([...values.slice(25, 31)]).toEqual([2, 0, 0.25, 0, 0.5, 1]);
});

test('extension slots share UV overrides and independently select authored normal bases', () => {
  const info = {
    index: 0,
    texCoord: 0,
    extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.5, 0], scale: [2, 3] } },
  };
  const material: Material = {
    extensions: {
      KHR_materials_clearcoat: {
        clearcoatTexture: info,
        clearcoatNormalTexture: { ...info, scale: 0.5 },
      },
      KHR_materials_specular: { specularColorTexture: info, specularTexture: info },
      KHR_materials_transmission: { transmissionTexture: info },
      KHR_materials_volume: { thicknessTexture: info },
    },
  };
  const values = materialUniform(material);
  for (const slot of [5, 7, 8, 9, 10, 11]) {
    expect(materialTextureSlots[slot].read(material)).toEqual(
      slot === 7 ? { ...info, scale: 0.5 } : info,
    );
    expect([...values.slice(32 + slot * 8, 40 + slot * 8)]).toEqual([2, -0, 0.5, 1, 0, 3, 0, 0]);
  }
  expect(values[15]).toBe(1); // Base normal basis unchanged.
  expect(values[31]).toBe(0); // Coat requires derivatives of transformed UV1.
});

test('rejects malformed extension factors and attenuation rather than uploading NaN or infinity', () => {
  for (const extensions of [
    { KHR_materials_clearcoat: { clearcoatFactor: 1.1 } },
    { KHR_materials_clearcoat: { clearcoatRoughnessFactor: -1 } },
    { KHR_materials_specular: { specularFactor: NaN } },
    { KHR_materials_specular: { specularColorFactor: [1, 1] } },
    { KHR_materials_ior: { ior: 0.5 } },
    { KHR_materials_volume: { attenuationDistance: 0 } },
    { KHR_materials_volume: { attenuationColor: [1, -1, 1] } },
    { KHR_materials_transmission: { transmissionFactor: 2 } },
    { KHR_materials_emissive_strength: { emissiveStrength: Infinity } },
  ])
    expect(() => materialUniform({ extensions })).toThrow();
});
