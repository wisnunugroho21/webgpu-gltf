import { describe, expect, it } from 'vitest';
import { textureCoordinates, uvLocation } from '../src/gltf/texture-coordinates';
import { samplerDescriptor } from '../src/renderer/samplers';
import { mipLevelCount } from '../src/renderer/mipmaps';
import { prepareGeometry } from '../src/gltf/geometry';
import { animatedAsset } from './fixtures/animated';

describe('texture coordinates', () => {
  it('packs identity defaults and applies scale, rotation, then offset with extension override', () => {
    expect([...textureCoordinates()]).toEqual([1, -0, 0, 0, 0, 1, 0, 0]);
    const rows = textureCoordinates({
      index: 0,
      texCoord: 0,
      extensions: {
        KHR_texture_transform: {
          texCoord: 7,
          scale: [2, -3],
          rotation: Math.PI / 2,
          offset: [4, 5],
        },
      },
    });
    expect(rows[3]).toBe(7);
    expect(rows[0] * 0.5 + rows[1] * 0.25 + rows[2]).toBeCloseTo(4.75);
    expect(rows[4] * 0.5 + rows[5] * 0.25 + rows[6]).toBeCloseTo(6);
  });
  it('rejects invalid UV selections and malformed/non-finite transforms', () => {
    for (const texCoord of [-1, 0.5, NaN])
      expect(() => textureCoordinates({ index: 0, texCoord })).toThrow('index');
    for (const transform of [{ offset: [1] }, { scale: [1, NaN] }, { rotation: Infinity }])
      expect(() =>
        textureCoordinates({ index: 0, extensions: { KHR_texture_transform: transform } }),
      ).toThrow('transform');
  });
  it('binds normalized sparse UV sets without requiring TEXCOORD_0', () => {
    const asset = animatedAsset();
    const buffer = asset.buffers.length;
    asset.buffers.push(new Uint8Array([64, 192]).buffer, new Uint8Array([2]).buffer);
    const view = asset.gltf.bufferViews!.length;
    asset.gltf.bufferViews!.push({ buffer, byteLength: 2 }, { buffer: buffer + 1, byteLength: 1 });
    const index = asset.gltf.accessors!.length;
    asset.gltf.accessors!.push({
      count: 3,
      type: 'VEC2',
      componentType: 5121,
      normalized: true,
      sparse: {
        count: 1,
        indices: { bufferView: view + 1, componentType: 5121 },
        values: { bufferView: view },
      },
    });
    const primitive = asset.gltf.meshes![0].primitives[0];
    primitive.attributes.TEXCOORD_7 = index;
    const geometry = prepareGeometry(asset, primitive);
    expect(geometry.features.uvSets).toEqual([7]);
    const uv = geometry.bindings.find((binding) =>
      [...binding.layout.attributes].some((attribute) => attribute.shaderLocation === 5),
    )!;
    expect(uv.source).toBeInstanceOf(Float32Array);
    expect((uv.source as Float32Array)[4]).toBeCloseTo(64 / 255);
    expect(uvLocation(7, [0, 1, 7])).toBe(6);
  });
});

describe('mip filtering', () => {
  it('enables anisotropy only for compatible trilinear samplers and preserves explicit filters', () => {
    expect(samplerDescriptor().maxAnisotropy).toBe(16);
    expect(samplerDescriptor({ minFilter: 9987, magFilter: 9729 }).maxAnisotropy).toBe(16);
    expect(samplerDescriptor({}, 4).maxAnisotropy).toBe(4);
    expect(samplerDescriptor({}, 1).maxAnisotropy).toBe(1);
    for (const minFilter of [9728, 9729, 9984, 9985, 9986])
      expect(samplerDescriptor({ minFilter }).maxAnisotropy).toBe(1);
    expect(samplerDescriptor({ minFilter: 9987, magFilter: 9728 }).maxAnisotropy).toBe(1);
    for (const value of [0, 17, 1.5, NaN])
      expect(() => samplerDescriptor({}, value)).toThrow('Anisotropy');
  });
  it('maps all six glTF minification modes and reserves level zero for non-mip modes', () => {
    for (const [mode, min, mip, clamp] of [
      [9728, 'nearest', 'linear', 0],
      [9729, 'linear', 'linear', 0],
      [9984, 'nearest', 'nearest', 32],
      [9985, 'linear', 'nearest', 32],
      [9986, 'nearest', 'linear', 32],
      [9987, 'linear', 'linear', 32],
    ] as const) {
      expect(samplerDescriptor({ minFilter: mode })).toMatchObject({
        minFilter: min,
        mipmapFilter: mip,
        lodMaxClamp: clamp,
      });
    }
    expect(mipLevelCount(1, 1)).toBe(1);
    expect(mipLevelCount(5, 3)).toBe(3);
    expect(mipLevelCount(1, 8)).toBe(4);
  });
});
