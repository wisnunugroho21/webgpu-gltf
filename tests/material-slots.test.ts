import { describe, expect, it } from 'vitest';
import { createMaterialLayoutEntries, materialTextureSlots } from '../src/renderer/materials/slots';
import { shaderSource } from '../src/renderer/render/shader';

describe('material texture interface', () => {
  it('keeps the explicit material bindings identical across all vertex-input variants', () => {
    const bindings = Array.from({ length: 11 }, (_, binding) => binding);
    const entries = createMaterialLayoutEntries(2); // fragment-stage bit; no browser globals
    expect(entries.map((entry) => entry.binding)).toEqual(bindings);
    expect(entries[0].buffer).toEqual({ type: 'uniform', minBindingSize: 224 });
    for (const normal of [false, true])
      for (const uvSets of [[], [0], [1], [0, 1], [0, 7]])
        for (const color of [0, 3, 4])
          for (const tangent of [false, true]) {
            const source = shaderSource({ normal, uv: uvSets.length > 0, uvSets, color, tangent });
            const declarations = [...source.matchAll(/@group\(2\) @binding\((\d+)\)/g)];
            expect(declarations.map((match) => Number(match[1]))).toEqual(bindings);
          }
  });

  it('uses sRGB only for color slots and multiplicative identities for missing maps', () => {
    expect(
      materialTextureSlots.map((slot) => [slot.shaderName, slot.format, slot.neutral]),
    ).toEqual([
      ['color', 'rgba8unorm-srgb', [255, 255, 255, 255]],
      ['emissive', 'rgba8unorm-srgb', [255, 255, 255, 255]],
      ['metallicRoughness', 'rgba8unorm', [255, 255, 255, 255]],
      ['normal', 'rgba8unorm', [128, 128, 255, 255]],
      ['occlusion', 'rgba8unorm', [255, 255, 255, 255]],
    ]);
    expect(materialTextureSlots.map((slot) => slot.read({}))).toEqual(new Array(5).fill(undefined));
  });
});
