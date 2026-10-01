/** Original Radiance fixtures; no downloaded panorama or third-party license needed. */
export function hdrBytes(
  payload: number[],
  resolution = '-Y 1 +X 2',
  fields = 'FORMAT=32-bit_rle_rgbe',
  newline = '\n',
): Uint8Array {
  const header = new TextEncoder().encode(['#?RADIANCE', fields, '', resolution, ''].join(newline));
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}
export function constantHdr(width = 8, height = 4): Uint8Array {
  const payload: number[] = [];
  for (let y = 0; y < height; y++) {
    payload.push(2, 2, width >> 8, width & 255);
    for (const value of [128, 64, 32, 130]) payload.push(128 + width, value);
  }
  return hdrBytes(payload, `-Y ${height} +X ${width}`);
}
