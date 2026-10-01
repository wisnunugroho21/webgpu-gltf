import { expect, test } from 'vitest';
import { basisTargets, imageLevelBytes } from '../src/gltf/compression/textures';
import {
  compressedFormat,
  compressionRequirements,
  compressionSupport,
  prepareTextureCompression,
} from '../src/renderer/textures/compression';
import type { Asset, DecodedImage } from '../src/gltf/types';

test('deliberate RGBA fallback is reused for the same capabilities without restarting a worker', async () => {
  const image: DecodedImage = {
    format: 'rgba8',
    transcodedFor: ['astc'],
    levels: [{ width: 4, height: 4, data: new Uint8Array(64) }],
  };
  const asset: Asset = {
    gltf: {
      asset: { version: '2.0' },
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    },
    images: [],
    buffers: [],
    warnings: [],
    decodedImages: new Map([[0, image]]),
  };
  const prepared = await prepareTextureCompression(asset, new Set(['texture-compression-astc']));
  expect(prepared.decodedImages!.get(0)).toBe(image);
  expect(asset.decodedImages!.get(0)).toBe(image);
});

test('negotiates only supported optional features and keeps portable RGBA fallback', () => {
  const features = new Set([
    'texture-compression-bc',
    'texture-compression-astc',
    'timestamp-query',
  ]);
  expect(compressionRequirements(features)).toEqual([
    'texture-compression-bc',
    'texture-compression-astc',
  ]);
  expect(compressionSupport(features)).toEqual(['bc', 'astc']);
  expect(compressionRequirements(new Set())).toEqual([]);
  expect(basisTargets([])).toEqual([{ format: 'rgba8', transcoder: 13 }]);
  expect(basisTargets(['bc', 'etc2', 'astc'])).toEqual([
    { format: 'astc', transcoder: 10, uastcOnly: true },
    { format: 'bc7', transcoder: 6 },
    { format: 'etc2', transcoder: 1 },
    { format: 'rgba8', transcoder: 13 },
  ]);
});

test('GPU encoding follows the slot, and partial mip blocks retain full storage', () => {
  for (const [format, gpu] of [
    ['rgba8', 'rgba8unorm'],
    ['bc7', 'bc7-rgba-unorm'],
    ['etc2', 'etc2-rgba8unorm'],
    ['astc', 'astc-4x4-unorm'],
  ] as const) {
    expect(compressedFormat(format, false)).toBe(gpu);
    expect(compressedFormat(format, true)).toBe(`${gpu}-srgb`);
    expect(imageLevelBytes(format, 12, 20)).toBe(format === 'rgba8' ? 960 : 240);
    expect(imageLevelBytes(format, 2, 1)).toBe(format === 'rgba8' ? 8 : 16);
    expect(imageLevelBytes(format, 5, 7)).toBe(format === 'rgba8' ? 140 : 64);
  }
});
