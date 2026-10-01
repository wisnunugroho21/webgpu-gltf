/** Equirectangular RGBA pixels in linear radiance units; RGB may exceed one. */
export interface EnvironmentImage {
  width: number;
  height: number;
  pixels: Float32Array;
}
