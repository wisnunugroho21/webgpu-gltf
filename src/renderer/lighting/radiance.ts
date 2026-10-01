import type { EnvironmentImage } from './types';

/** Radiance RGBE panoramas already contain linear radiance, not sRGB colors.
 * Decode independently of browser image APIs, which commonly quantize HDR to LDR.
 * Format reference: https://radsite.lbl.gov/radiance/refer/Notes/picture_format.html
 */
export function decodeRadiance(data: Uint8Array): EnvironmentImage {
  let offset = 0;
  const fail = (message: string): never => {
    throw new Error(`Invalid HDR environment: ${message}`);
  };
  const byte = (): number => {
    if (offset >= data.length) fail('truncated pixel data.');
    return data[offset++];
  };
  const line = (): string => {
    const start = offset;
    while (offset < data.length && data[offset] !== 10) offset++;
    if (offset === data.length || offset > 65536) fail('missing or oversized header.');
    const text = new TextDecoder('ascii').decode(data.subarray(start, offset++)).replace(/\r$/, '');
    return text;
  };
  if (!/^#\?\S+/.test(line())) fail('missing Radiance signature.');
  let format = '';
  for (let header = line(); header !== ''; header = line()) {
    const match = /^FORMAT\s*=\s*(\S+)\s*$/.exec(header);
    if (match) format = match[1];
  }
  if (format !== '32-bit_rle_rgbe') fail('expected FORMAT=32-bit_rle_rgbe (XYZE is unsupported).');
  const resolution = /^\s*([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)\s*$/.exec(line());
  if (!resolution || resolution[2] === resolution[5]) fail('invalid resolution/orientation.');
  const axes = [
    { sign: resolution![1], axis: resolution![2], size: Number(resolution![3]) },
    { sign: resolution![4], axis: resolution![5], size: Number(resolution![6]) },
  ];
  const [major, minor] = axes;
  const width = axes.find((axis) => axis.axis === 'X')!.size;
  const height = axes.find((axis) => axis.axis === 'Y')!.size;
  // Bound allocation before trusting dimensions from a file. 32M pixels covers 8K
  // panoramas; the GPU independently checks its texture dimension limit on upload.
  if (
    ![width, height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 32768) ||
    width * height > 32 * 1024 * 1024
  )
    fail('dimensions exceed the 32M-pixel decoder limit.');
  const pixels = new Float32Array(width * height * 4);
  const scanline = new Uint8Array(minor.size * 4);
  const previous = new Uint8Array(4);
  let hasPrevious = false;
  let legacyRun = 0;
  let legacyShift = 0;
  // +X runs left-to-right; -Y runs top-to-bottom. Also handle reversed axes and
  // X-major files by writing directly into canonical top-left RGBA coordinates.
  const coordinate = (axis: typeof major, index: number) =>
    (axis.axis === 'X' ? axis.sign === '+' : axis.sign === '-') ? index : axis.size - 1 - index;
  const write = (row: number, column: number, r: number, g: number, b: number, e: number) => {
    const a = coordinate(major, row),
      c = coordinate(minor, column);
    const x = major.axis === 'X' ? a : c,
      y = major.axis === 'Y' ? a : c;
    const target = (y * width + x) * 4;
    const scale = e === 0 ? 0 : 2 ** (e - 136); // Shared exponent biased by 128, 8-bit mantissa.
    if (Math.max(r, g, b) * scale > 65504)
      fail('radiance exceeds float16 range (65504); reduce the source exposure.');
    pixels[target] = r * scale;
    pixels[target + 1] = g * scale;
    pixels[target + 2] = b * scale;
    pixels[target + 3] = 1;
  };
  for (let row = 0; row < major.size; row++) {
    const modern =
      legacyRun === 0 &&
      legacyShift === 0 &&
      minor.size >= 8 &&
      minor.size <= 32767 &&
      data[offset] === 2 &&
      data[offset + 1] === 2 &&
      (data[offset + 2] & 128) === 0;
    if (modern) {
      byte();
      byte();
      if (byte() * 256 + byte() !== minor.size) fail('scanline length mismatch.');
      for (let channel = 0; channel < 4; channel++) {
        let column = 0;
        while (column < minor.size) {
          const code = byte();
          const count = code > 128 ? code - 128 : code;
          if (count === 0 || column + count > minor.size) fail('invalid scanline run.');
          if (code > 128) {
            scanline.fill(
              byte(),
              channel * minor.size + column,
              channel * minor.size + column + count,
            );
          } else {
            if (offset + count > data.length) fail('truncated literal run.');
            scanline.set(data.subarray(offset, offset + count), channel * minor.size + column);
            offset += count;
          }
          column += count;
        }
      }
      for (let column = 0; column < minor.size; column++)
        write(
          row,
          column,
          scanline[column],
          scanline[minor.size + column],
          scanline[2 * minor.size + column],
          scanline[3 * minor.size + column],
        );
      hasPrevious = false;
    } else {
      // Legacy (1,1,1,n) repeats the previous RGBE pixel. Consecutive markers
      // encode base-256 count digits; avoid bit shifts, whose JS range is only 32 bits.
      for (let column = 0; column < minor.size; column++) {
        if (!legacyRun) {
          const r = byte(),
            g = byte(),
            b = byte(),
            e = byte();
          if (r === 1 && g === 1 && b === 1) {
            if (!hasPrevious || legacyShift > 24) fail('invalid legacy run.');
            legacyRun = e * 2 ** legacyShift;
            legacyShift += 8;
            const remaining = (major.size - row) * minor.size - column;
            if (legacyRun > remaining) fail('legacy run exceeds image size.');
            column--; // Process this marker without consuming a pixel position.
            continue;
          }
          previous[0] = r;
          previous[1] = g;
          previous[2] = b;
          previous[3] = e;
          hasPrevious = true;
          legacyShift = 0;
        } else legacyRun--;
        write(row, column, previous[0], previous[1], previous[2], previous[3]);
      }
    }
  }
  return { width, height, pixels };
}
