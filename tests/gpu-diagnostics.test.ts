import { expect, test } from 'vitest';
import { textureBytes } from '../src/renderer/core/diagnostics';
const texture = (
  format: GPUTextureFormat,
  size: GPUExtent3D,
  mipLevelCount = 1,
  sampleCount = 1,
  dimension: GPUTextureDimension = '2d',
): GPUTextureDescriptor => ({ format, size, mipLevelCount, sampleCount, dimension, usage: 0 });
test('memory counts compressed tails, layers, volumes, HDR and multisampling', () => {
  expect(textureBytes(texture('bc1-rgba-unorm', [8, 8], 4))).toBe(56);
  expect(textureBytes(texture('etc2-rgb8a1unorm', [4, 4]))).toBe(8);
  expect(textureBytes(texture('etc2-rgba8unorm', [4, 4]))).toBe(16);
  expect(textureBytes(texture('astc-6x6-unorm', [12, 12], 4))).toBe(112);
  expect(textureBytes(texture('rgba16float', [8, 8, 2], 4))).toBe(1360);
  expect(textureBytes(texture('rgba16float', [8, 8], 1, 4))).toBe(2048);
  expect(textureBytes(texture('rgba8unorm', [4, 4, 4], 3, 1, '3d'))).toBe(292);
  expect(() => textureBytes(texture('r8unorm', [4, 4]))).toThrow('Unmeasured');
});
