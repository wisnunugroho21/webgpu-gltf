import { expect, test } from 'vitest';
import { studioEnvironment, validateEnvironment } from '../src/renderer/environment-source';

test('offline studio is finite linear HDR and panorama dimensions match its pixels', () => {
  const image = studioEnvironment();
  expect(() => validateEnvironment(image)).not.toThrow();
  expect(image.width).toBe(image.height * 2);
  expect(image.pixels.some((v) => v > 1)).toBe(true);
  expect([...image.pixels.filter((_, i) => i % 4 === 3)].every((v) => v === 1)).toBe(true);
});

test('environment inputs reject malformed sizes, negative, nonfinite and overflowing values', () => {
  for (const value of [-1, NaN, Infinity, 65505])
    expect(() =>
      validateEnvironment({ width: 1, height: 1, pixels: new Float32Array([value, 0, 0, 1]) }),
    ).toThrow();
  for (const width of [0, -1, 1.5, Infinity, 2])
    expect(() => validateEnvironment({ width, height: 1, pixels: new Float32Array(4) })).toThrow();
});
