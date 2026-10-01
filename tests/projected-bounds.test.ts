import { expect, test } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { projectBounds } from '../src/renderer/scene/projected-bounds';

const bounds = (min: number[], max: number[]) => ({
  min: vec3.fromValues(...(min as [number, number, number])),
  max: vec3.fromValues(...(max as [number, number, number])),
});

test('projected size uses the larger physical-pixel extent, includes all corners and scales with viewport/distance', () => {
  const projection = mat4.perspectiveZO(mat4.create(), Math.PI / 2, 2, 0.1, 100);
  const b = bounds([-1, -1, -6], [1, 1, -4]);
  const p = projectBounds(b, projection, 800, 400)!;
  expect(p.pixels).toBeCloseTo(100);
  expect(projectBounds(b, projection, 1600, 800)!.pixels).toBeCloseTo(200);
  expect(
    projectBounds(bounds([-1, -1, -12], [1, 1, -8]), projection, 800, 400)!.pixels,
  ).toBeCloseTo(50);
  for (let i = 0; i < 8; i++) {
    const corner = vec3.fromValues(
      i & 1 ? b.max[0] : b.min[0],
      i & 2 ? b.max[1] : b.min[1],
      i & 4 ? b.max[2] : b.min[2],
    );
    const projected = vec3.transformMat4(vec3.create(), corner, projection);
    expect(projected[0]).toBeGreaterThanOrEqual(p.minX);
    expect(projected[0]).toBeLessThanOrEqual(p.maxX);
    expect(projected[1]).toBeGreaterThanOrEqual(p.minY);
    expect(projected[1]).toBeLessThanOrEqual(p.maxY);
    expect(projected[2]).toBeGreaterThan(p.depth);
  }
});

test('near-plane, camera-enclosing, behind-camera and invalid bounds fail open', () => {
  const projection = mat4.perspectiveZO(mat4.create(), Math.PI / 2, 1, 1, 100);
  for (const b of [
    bounds([-1, -1, -2], [1, 1, -0.5]),
    bounds([-1, -1, -2], [1, 1, 2]),
    bounds([-1, -1, 2], [1, 1, 3]),
    bounds([2, 0, -3], [1, 1, -2]),
    bounds([NaN, 0, -3], [1, 1, -2]),
  ])
    expect(projectBounds(b, projection, 800, 800)).toBeUndefined();
});

test('orthographic and flattened boxes project without underestimating un-clipped screen extent', () => {
  const p = projectBounds(bounds([-2, -0.1, 0.5], [2, 0.1, 0.5]), mat4.create(), 100, 100)!;
  expect(p.pixels).toBe(200);
  expect(p.depth).toBeLessThan(0.5);
});
