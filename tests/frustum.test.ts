import { expect, test } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
  Frustum,
  createBounds,
  transformBounds,
  visibleInstanceRuns,
} from '../src/renderer/frustum';
import { Deformation } from '../src/gltf/deformation';
import { Pose } from '../src/gltf/animation';
import { animatedAsset } from './fixtures/animated';

const box = (x: number, y: number, z: number, extent = 0.1) => ({
  min: vec3.fromValues(x - extent, y - extent, z - extent),
  max: vec3.fromValues(x + extent, y + extent, z + extent),
});

test('WebGPU near/far and all side planes reject outside boxes while keeping crossing, touching and enclosing bounds', () => {
  const frustum = new Frustum();
  frustum.update(mat4.create());
  expect(frustum.intersects(box(0, 0, 0.5))).toBe(true);
  for (const [x, y, z] of [
    [-2, 0, 0.5],
    [2, 0, 0.5],
    [0, -2, 0.5],
    [0, 2, 0.5],
    [0, 0, -0.2],
    [0, 0, 1.2],
  ])
    expect(frustum.intersects(box(x, y, z))).toBe(false);
  expect(frustum.intersects(box(0, 0, -0.05))).toBe(true);
  expect(frustum.intersects(box(1.1, 0, 0.5))).toBe(true);
  expect(frustum.intersects(box(0, 0, 0.5, 10))).toBe(true);
});

test('perspective and rotated cameras use zero-to-one depth, rejecting behind-camera bounds', () => {
  const frustum = new Frustum(),
    projection = mat4.perspectiveZO(mat4.create(), Math.PI / 2, 1, 1, 10);
  frustum.update(projection);
  expect(frustum.intersects(box(0, 0, -2))).toBe(true);
  for (const b of [box(0, 0, 2), box(0, 0, -0.5), box(0, 0, -11), box(3, 0, -2)])
    expect(frustum.intersects(b)).toBe(false);
  expect(frustum.intersects(box(2, 0, -2, 0.2))).toBe(true);
  const view = mat4.lookAt(mat4.create(), [5, 0, 0], [0, 0, 0], [0, 1, 0]);
  frustum.update(mat4.multiply(mat4.create(), projection, view));
  expect(frustum.intersects(box(0, 0, 0))).toBe(true);
  expect(frustum.intersects(box(7, 0, 0))).toBe(false);
  expect(frustum.intersects(box(-8, 0, 0))).toBe(false);
});

test('affine AABB transforms enclose every rotated, sheared and reflected corner', () => {
  const source = { min: vec3.fromValues(-2, 1, -0.5), max: vec3.fromValues(3, 4, 2) },
    out = createBounds();
  const matrix = mat4.fromRotationTranslationScale(
    mat4.create(),
    [0, Math.sin(0.4), 0, Math.cos(0.4)],
    [4, -2, 3],
    [-2, 0.5, 3],
  );
  matrix[4] += 0.4;
  transformBounds(out, source, matrix);
  for (let corner = 0; corner < 8; corner++) {
    const point = vec3.transformMat4(
      vec3.create(),
      [
        corner & 1 ? source.max[0] : source.min[0],
        corner & 2 ? source.max[1] : source.min[1],
        corner & 4 ? source.max[2] : source.min[2],
      ],
      matrix,
    );
    for (let c = 0; c < 3; c++) {
      expect(point[c]).toBeGreaterThanOrEqual(out.min[c] - 1e-5);
      expect(point[c]).toBeLessThanOrEqual(out.max[c] + 1e-5);
    }
  }
});

test('visible runs preserve absolute instance indices, coalesce adjacent survivors and clear old results', () => {
  const frustum = new Frustum();
  frustum.update(mat4.create());
  const bounds = [box(0, 0, 0.5), box(3, 0, 0.5), box(0, 0, 0.5), box(0, 0, 0.5), box(3, 0, 0.5)];
  const out = [99, 9];
  visibleInstanceRuns(frustum, bounds, 7, out);
  expect(out).toEqual([7, 1, 9, 2]);
  visibleInstanceRuns(frustum, bounds, 7, out, false);
  expect(out).toEqual([7, 5]);
  visibleInstanceRuns(frustum, [box(3, 0, 0.5)], 7, out);
  expect(out).toEqual([]);
});

test('degenerate planes, invalid bounds and tiny boundary errors fail open', () => {
  const frustum = new Frustum();
  frustum.update(new Float32Array(16));
  expect(frustum.intersects(box(100, 100, 100))).toBe(true);
  frustum.update(mat4.create());
  expect(frustum.intersects(box(1.000001, 0, 0.5, 0))).toBe(true);
  expect(
    frustum.intersects({ min: vec3.fromValues(NaN, 0, 0), max: vec3.fromValues(Infinity, 0, 0) }),
  ).toBe(true);
  frustum.update(mat4.perspectiveZO(mat4.create(), Math.PI / 2, 1, 1, Infinity));
  expect(frustum.intersects(box(0, 0, -100000))).toBe(true);
});

test('morph and skin envelopes contain CPU reference vertices for signed weights and reflected joints', () => {
  const asset = animatedAsset(),
    pose = new Pose(asset),
    primitive = asset.gltf.meshes![0].primitives[0];
  const skin = new Deformation(asset, primitive, 0, pose),
    morph = new Deformation(asset, primitive, 3, pose);
  pose.nodes[2].world[0] = -2;
  pose.nodes[2].world[4] = 0.3;
  pose.nodes[2].world[12] = 4;
  const bounds = createBounds();
  for (const weight of [-1, 0, 1, 2.3])
    for (const deformation of [skin, morph]) {
      pose.nodes[deformation.node].weights[0] = weight;
      deformation.update();
      deformation.bounds(bounds.min, bounds.max);
      const positions = deformation.streams[0].values;
      for (let i = 0; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThanOrEqual(bounds.min[i % 3] - 1e-5);
        expect(positions[i]).toBeLessThanOrEqual(bounds.max[i % 3] + 1e-5);
      }
    }
});
