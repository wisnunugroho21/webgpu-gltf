import { vec3 } from 'gl-matrix';

export interface Bounds {
  min: vec3;
  max: vec3;
}
export function createBounds(): Bounds {
  return { min: vec3.create(), max: vec3.create() };
}

/** Transform an affine AABB using its center and half extents. Absolute matrix terms
 * account for rotation, shear, nonuniform scale and reflections without allocating corners. */
export function transformBounds(out: Bounds, bounds: Bounds, matrix: ArrayLike<number>): void {
  const x = (bounds.min[0] + bounds.max[0]) / 2,
    y = (bounds.min[1] + bounds.max[1]) / 2,
    z = (bounds.min[2] + bounds.max[2]) / 2;
  const ex = (bounds.max[0] - bounds.min[0]) / 2,
    ey = (bounds.max[1] - bounds.min[1]) / 2,
    ez = (bounds.max[2] - bounds.min[2]) / 2;
  for (let c = 0; c < 3; c++) {
    const center = matrix[c] * x + matrix[4 + c] * y + matrix[8 + c] * z + matrix[12 + c];
    const extent =
      Math.abs(matrix[c]) * ex + Math.abs(matrix[4 + c]) * ey + Math.abs(matrix[8 + c]) * ez;
    out.min[c] = center - extent;
    out.max[c] = center + extent;
  }
}

/** WebGPU's clip volume is -w <= x,y <= w and 0 <= z <= w. In particular the
 * near plane is row 2, NOT row 3 + row 2 as in an OpenGL depth projection. */
export class Frustum {
  private planes = new Float64Array(24);
  update(matrix: ArrayLike<number>): void {
    for (let plane = 0; plane < 6; plane++) {
      const row = plane < 4 ? Math.floor(plane / 2) : 2;
      const sign = plane % 2 === 0 ? 1 : -1;
      for (let c = 0; c < 4; c++)
        this.planes[plane * 4 + c] =
          plane === 4 ? matrix[c * 4 + 2] : matrix[c * 4 + 3] + sign * matrix[c * 4 + row];
      const offset = plane * 4;
      const length = Math.hypot(
        this.planes[offset],
        this.planes[offset + 1],
        this.planes[offset + 2],
      );
      // Degenerate/infinite planes fail open, e.g. an infinite far projection.
      const valid =
        length > 0 && Number.isFinite(length) && Number.isFinite(this.planes[offset + 3]);
      for (let c = 0; c < 4; c++)
        this.planes[offset + c] = valid ? this.planes[offset + c] / length : 0;
    }
  }
  intersects(bounds: Bounds): boolean {
    for (let c = 0; c < 3; c++)
      if (
        !Number.isFinite(bounds.min[c]) ||
        !Number.isFinite(bounds.max[c]) ||
        bounds.min[c] > bounds.max[c]
      )
        return true;
    for (let p = 0; p < 24; p += 4) {
      const nx = this.planes[p],
        ny = this.planes[p + 1],
        nz = this.planes[p + 2];
      // The furthest corner along the inward normal is the last one to leave a plane.
      const x = nx * (nx >= 0 ? bounds.max[0] : bounds.min[0]);
      const y = ny * (ny >= 0 ? bounds.max[1] : bounds.min[1]);
      const z = nz * (nz >= 0 ? bounds.max[2] : bounds.min[2]);
      const d = this.planes[p + 3];
      const tolerance = 1e-5 * (1 + Math.abs(x) + Math.abs(y) + Math.abs(z) + Math.abs(d));
      if (x + y + z + d < -tolerance) return false;
    }
    return true;
  }
}

/** Keep original instance indices and emit contiguous visible runs. Fully visible batches
 * remain one instanced draw; hidden gaps are skipped without repacking transforms. */
export function visibleInstanceRuns(
  frustum: Frustum,
  bounds: readonly Bounds[],
  firstInstance: number,
  out: number[],
  enabled = true,
): void {
  out.length = 0;
  for (let i = 0; i < bounds.length; i++) {
    if (enabled && !frustum.intersects(bounds[i])) continue;
    const first = firstInstance + i;
    if (out.length && out[out.length - 2] + out[out.length - 1] === first) out[out.length - 1]++;
    else out.push(first, 1);
  }
}
