import type { Bounds } from './frustum';

export interface ProjectedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  depth: number;
  /** Conservative full AABB extent in physical viewport pixels, before screen clipping. */
  pixels: number;
}

/** Perspective extrema occur at corners when the entire box is in front of the near
 * plane. Crossing/invalid boxes fail open: dividing by W there could underestimate size
 * or build an occlusion proxy that misses visible geometry. No scratch arrays needed. */
export function projectBounds(
  bounds: Bounds,
  matrix: ArrayLike<number>,
  width: number,
  height: number,
): ProjectedBounds | undefined {
  for (let axis = 0; axis < 3; axis++)
    if (
      !Number.isFinite(bounds.min[axis]) ||
      !Number.isFinite(bounds.max[axis]) ||
      bounds.min[axis] > bounds.max[axis]
    )
      return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    depth = Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.max[0] : bounds.min[0];
    const y = corner & 2 ? bounds.max[1] : bounds.min[1];
    const z = corner & 4 ? bounds.max[2] : bounds.min[2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    if (!(w > 0) || !(clipZ > 1e-6 * w)) return;
    const px = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
    const py = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
    const pz = clipZ / w;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
    depth = Math.min(depth, pz);
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    // Move the proxy slightly toward the camera to avoid precision-induced self occlusion.
    depth: Math.max(0, Math.min(1, depth - 1e-5)),
    pixels: Math.max(((maxX - minX) * width) / 2, ((maxY - minY) * height) / 2),
  };
}
