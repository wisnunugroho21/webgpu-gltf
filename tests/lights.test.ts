import { expect, test } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import { materialAsset } from './fixtures/material';
import { Pose } from '../src/scene/pose';
import { PunctualLights, distanceAttenuation, spotAttenuation } from '../src/scene/lights';
import { shadowMatrices, pointShadowFace } from '../src/renderer/lighting/shadows/matrices';

test('selected punctual light instances inherit parent transforms and reuse immutable definitions', () => {
  const asset = materialAsset({});
  asset.gltf.extensions = {
    KHR_lights_punctual: {
      lights: [{ type: 'spot', spot: {}, intensity: 12, range: 9, color: [0.2, 0.4, 1] }],
    },
  };
  const rotation = quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
  asset.gltf.nodes!.push(
    { translation: [3, 4, 5], rotation: [...rotation], scale: [2, 2, 2], children: [2] },
    { translation: [0, 0, -1], extensions: { KHR_lights_punctual: { light: 0 } } },
    { translation: [9, 0, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
    { extensions: { KHR_lights_punctual: { light: 0 } } },
  );
  asset.gltf.scenes![0].nodes = [0, 1, 3];
  const pose = new Pose(asset);
  const lights = new PunctualLights(pose);
  expect(lights.instances).toHaveLength(2);
  expect(lights.authored).toBe(true);
  [1, 4, 5].forEach((value, i) => expect(lights.instances[0].position[i]).toBeCloseTo(value));
  expect(lights.instances[0].direction[0]).toBeCloseTo(-1);
  expect(lights.instances[0].range).toBe(9);
  expect(lights.instances[0].intensity).toBe(12);
  expect(lights.instances[1].position[0]).toBe(9);
  expect(lights.update()).toBe(false);
});

test('the fallback is present only when the selected scene has no authored light instances', () => {
  const asset = materialAsset({});
  const fallback = new PunctualLights(new Pose(asset));
  expect(fallback.authored).toBe(false);
  expect(fallback.instances[0].intensity).toBe(3);
  asset.gltf.extensions = {
    KHR_lights_punctual: { lights: [{ type: 'directional', intensity: 0 }] },
  };
  asset.gltf.nodes![0].extensions = { KHR_lights_punctual: { light: 0 } };
  const authored = new PunctualLights(new Pose(asset));
  expect(authored.authored).toBe(true);
  expect(authored.instances[0].intensity).toBe(0);
});

test('punctual attenuation follows inverse square, finite range and smooth spot cones', () => {
  expect(distanceAttenuation(2) / distanceAttenuation(4)).toBe(4);
  expect(distanceAttenuation(5, 4)).toBe(0);
  expect(distanceAttenuation(4, 4)).toBe(0);
  expect(spotAttenuation(1, 0.1, 0.5)).toBe(1);
  expect(spotAttenuation(Math.cos(0.5), 0.1, 0.5)).toBe(0);
  const halfway = (Math.cos(0.1) + Math.cos(0.5)) / 2;
  expect(spotAttenuation(halfway, 0.1, 0.5)).toBeCloseTo(0.25);
});

test('malformed light definitions fail before a scene can replace the current model', () => {
  for (const definition of [
    { type: 'spot', spot: { innerConeAngle: 0.5, outerConeAngle: 0.2 } },
    { type: 'point', range: 0 },
    { type: 'directional', intensity: -1 },
    { type: 'directional', color: [1, 1, 2] },
    { type: 'spot' },
  ]) {
    const asset = materialAsset({});
    asset.gltf.extensions = { KHR_lights_punctual: { lights: [definition as never] } };
    asset.gltf.nodes![0].extensions = { KHR_lights_punctual: { light: 0 } };
    expect(() => new PunctualLights(new Pose(asset))).toThrow();
  }
});

test('all point shadow faces project their own axis into the center of WebGPU clip space', () => {
  const asset = materialAsset({});
  asset.gltf.extensions = { KHR_lights_punctual: { lights: [{ type: 'point', range: 10 }] } };
  asset.gltf.nodes![0].extensions = { KHR_lights_punctual: { light: 0 } };
  const light = new PunctualLights(new Pose(asset)).instances[0];
  const matrices = shadowMatrices(light, {
    min: vec3.fromValues(-2, -2, -2),
    max: vec3.fromValues(2, 2, 2),
  });
  const axes = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  axes.forEach((axis, i) => {
    expect(pointShadowFace(axis)).toBe(i);
    const projected = vec3.transformMat4(vec3.create(), axis as vec3, matrices[i]);
    expect(projected[0]).toBeCloseTo(0);
    expect(projected[1]).toBeCloseTo(0);
    expect(projected[2]).toBeGreaterThan(0);
    expect(projected[2]).toBeLessThan(1);
  });
});
