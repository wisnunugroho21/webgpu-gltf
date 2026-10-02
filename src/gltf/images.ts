import { AssetBudget } from './limits';

/** Inspect dimensions before native bitmap decode or Basis transcode. Browser image
 * decoding remains lazy; this header check bounds its estimated RGBA pixel payload. */
export function validateImageHeader(bytes: ArrayBuffer, budget: AssetBudget, path: string): void {
  budget.at(path, () => {
    const view = new DataView(bytes),
      data = new Uint8Array(bytes);
    let width = 0,
      height = 0;
    if (
      bytes.byteLength >= 33 &&
      view.getUint32(0) === 0x89504e47 &&
      view.getUint32(4) === 0x0d0a1a0a
    ) {
      if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
        throw new Error('Invalid PNG IHDR.');
      width = view.getUint32(16);
      height = view.getUint32(20);
    } else if (
      bytes.byteLength >= 80 &&
      data
        .slice(0, 12)
        .every(
          (v, i) =>
            v === [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a][i],
        )
    ) {
      width = view.getUint32(20, true);
      height = view.getUint32(24, true);
      const levels = view.getUint32(40, true);
      if (
        view.getUint32(28, true) !== 0 ||
        view.getUint32(32, true) > 1 ||
        view.getUint32(36, true) !== 1 ||
        levels < 1 ||
        levels > 1 + Math.floor(Math.log2(Math.max(width, height))) ||
        80 + levels * 24 > bytes.byteLength
      )
        throw new Error('Invalid 2D KTX2 dimensions or mip count.');
      for (let mip = 0; mip < levels; mip++) {
        const offset = Number(view.getBigUint64(80 + mip * 24, true)),
          length = Number(view.getBigUint64(88 + mip * 24, true));
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          offset + length > bytes.byteLength
        )
          throw new Error('KTX2 mip exceeds source.');
      }
    } else if (bytes.byteLength >= 4 && view.getUint16(0) === 0xffd8) {
      let offset = 2;
      while (offset < data.length) {
        if (data[offset++] !== 0xff) throw new Error('Invalid JPEG marker.');
        while (data[offset] === 0xff) offset++;
        const marker = data[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > data.length) throw new Error('Truncated JPEG segment.');
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > data.length)
          throw new Error('Invalid JPEG segment length.');
        if (
          [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
            marker,
          )
        ) {
          if (length < 8) throw new Error('Truncated JPEG frame.');
          height = view.getUint16(offset + 3);
          width = view.getUint16(offset + 5);
          break;
        }
        offset += length;
      }
    } else throw new Error('Unsupported image header; expected PNG, JPEG or KTX2.');
    budget.image(width, height, path);
  });
}
