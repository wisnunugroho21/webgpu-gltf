export interface EnvironmentImage {
  width: number;
  height: number;
  pixels: Float32Array;
}

/** Public maps are equirectangular RGBA arrays in linear radiance units, allowing HDR
 * values above one without tying lighting to an image decoder or asset file format. */
export function validateEnvironment(image: EnvironmentImage): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.pixels.length !== image.width * image.height * 4 ||
    image.pixels.some((value) => !Number.isFinite(value) || value < 0 || value > 65504)
  )
    throw new Error(
      'Environment must contain finite nonnegative linear RGBA pixels within float16 range.',
    );
}

/** Original generated HDR studio panorama: sky/ground and two broad bright panels.
 * No external model, environment license, or network request is needed for initial lighting. */
export function studioEnvironment(): EnvironmentImage {
  const width = 256,
    height = 128;
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const theta = ((y + 0.5) / height) * Math.PI;
      const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const d = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      const sky = Math.max(0, d[1]);
      const key = Math.max(0, d[0] * 0.4364 + d[1] * 0.7638 + d[2] * 0.4364) ** 48 * 6;
      const fill = Math.max(0, -d[0] * 0.597 + d[1] * 0.398 + d[2] * 0.697) ** 24 * 2;
      pixels.set(
        [
          0.08 + sky * 0.2 + key + fill * 0.85,
          0.07 + sky * 0.3 + key * 0.95 + fill,
          0.06 + sky * 0.45 + key * 0.85 + fill * 1.1,
          1,
        ],
        (y * width + x) * 4,
      );
    }
  return { width, height, pixels };
}

/** Browser-decoded PNG/JPEG panoramas are sRGB images, converted once to linear pixels.
 * They are LDR sources; callers can supply linear HDR arrays through the renderer API. */
export async function loadEnvironmentImage(blob: Blob): Promise<EnvironmentImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not decode environment image.');
    context.drawImage(bitmap, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i] / 255;
      pixels[i] = i % 4 === 3 ? 1 : v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }
    return { width: bitmap.width, height: bitmap.height, pixels };
  } finally {
    bitmap.close();
  }
}
