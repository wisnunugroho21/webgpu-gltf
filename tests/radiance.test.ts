import { expect, test } from 'vitest';
import { decodeRadiance } from '../src/renderer/lighting/radiance';
import { loadEnvironmentImage, validateEnvironment } from '../src/renderer/lighting/source';
import { constantHdr, hdrBytes } from './fixtures/hdr';

const red = (image: ReturnType<typeof decodeRadiance>) => [
  ...image.pixels.filter((_, i) => i % 4 === 0),
];

test('RGBE flat pixels preserve linear HDR, black exponent and opaque alpha', () => {
  const image = decodeRadiance(hdrBytes([128, 64, 32, 130, 255, 255, 255, 0]));
  expect([...image.pixels]).toEqual([2, 1, 0.5, 1, 0, 0, 0, 1]);
  expect(() => validateEnvironment(image)).not.toThrow();
});

test('modern RLE decodes constant and mixed literal/run scanlines including literal code 128', () => {
  const image = decodeRadiance(constantHdr());
  expect(image.width).toBe(8);
  expect(image.height).toBe(4);
  for (let i = 0; i < image.pixels.length; i++) expect(image.pixels[i]).toBe([2, 1, 0.5, 1][i % 4]);
  const mixed = decodeRadiance(
    hdrBytes([2, 2, 0, 8, 3, 32, 64, 96, 133, 128, 136, 0, 136, 0, 136, 128], '-Y 1 +X 8'),
  );
  expect(red(mixed)).toEqual([0.125, 0.25, 0.375, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const literal = decodeRadiance(
    hdrBytes(
      [2, 2, 0, 128, ...[128, 64, 32, 130].flatMap((value) => [128, ...Array(128).fill(value)])],
      '-Y 1 +X 128',
    ),
  );
  expect(red(literal)).toEqual(Array(128).fill(2));
});

test('legacy repeated pixels and base-256 runs can span row boundaries', () => {
  const image = decodeRadiance(
    hdrBytes([128, 0, 0, 129, 1, 1, 1, 0, 1, 1, 1, 1, 64, 0, 0, 129], '-Y 129 +X 2'),
  );
  expect(red(image)).toEqual([...Array(257).fill(1), 0.5]);
});

test('resolution signs and X-major storage normalize into top-left rows', () => {
  const payload = [1, 2, 3, 4, 5, 6].flatMap((v) => [v * 32, 0, 0, 128]);
  expect(red(decodeRadiance(hdrBytes(payload, '+Y 3 -X 2')))).toEqual(
    [6, 5, 4, 3, 2, 1].map((v) => v / 8),
  );
  expect(red(decodeRadiance(hdrBytes(payload, '+X 2 -Y 3')))).toEqual(
    [1, 4, 2, 5, 3, 6].map((v) => v / 8),
  );
  expect(red(decodeRadiance(hdrBytes(payload, '-X 2 +Y 3')))).toEqual(
    [6, 3, 5, 2, 4, 1].map((v) => v / 8),
  );
});

test('CRLF headers, comments, metadata and RGBE nameless blobs load without browser conversion', async () => {
  const bytes = hdrBytes(
    [128, 64, 32, 130, 128, 64, 32, 130],
    '-Y 1 +X 2',
    '# comment\r\nFORMAT=32-bit_rle_rgbe\r\nEXPOSURE=2\r\nGAMMA=2.2',
    '\r\n',
  );
  // Stored radiance is used as-is; exposure/gamma metadata are not extra corrections.
  const image = await loadEnvironmentImage(new Blob([bytes.slice().buffer]));
  expect([...image.pixels]).toEqual([2, 1, 0.5, 1, 2, 1, 0.5, 1]);
});

test('invalid headers, sizes, runs, truncation, XYZE and float16 overflow fail clearly', () => {
  const invalid = [
    new TextEncoder().encode('invalid'),
    hdrBytes([], '-Y 0 +X 2'),
    hdrBytes([], '-Y 100000000 +X 2'),
    hdrBytes([], '-Y 8192 +X 8192'),
    hdrBytes([], '-Y 1 -Y 2'),
    hdrBytes([], '-Y 1 +X 2', 'FORMAT=32-bit_rle_xyze'),
    hdrBytes([128, 64, 32]),
    hdrBytes([1, 1, 1, 1]),
    hdrBytes([128, 0, 0, 128, 1, 1, 1, 2]),
    hdrBytes([2, 2, 0, 9], '-Y 1 +X 8'),
    hdrBytes([2, 2, 0, 8, 0], '-Y 1 +X 8'),
    hdrBytes([2, 2, 0, 8, 137, 128], '-Y 1 +X 8'),
    hdrBytes([2, 2, 0, 8, 8, 128], '-Y 1 +X 8'),
    hdrBytes([255, 0, 0, 145, 0, 0, 0, 0]),
  ];
  for (const bytes of invalid) expect(() => decodeRadiance(bytes)).toThrow('HDR environment');
  const valid = constantHdr();
  for (let n = 0; n < valid.length; n++)
    expect(() => decodeRadiance(valid.subarray(0, n))).toThrow();
});
