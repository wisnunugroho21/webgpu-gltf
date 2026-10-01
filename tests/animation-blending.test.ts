import { expect, test } from 'vitest';
import { AnimationController } from '../src/animation/controller';
import { Pose } from '../src/scene/pose';
import { animatedAsset } from './fixtures/animated';

function player() {
  const pose = new Pose(animatedAsset());
  const animation = new AnimationController();
  animation.setPose(pose);
  animation.update(0);
  return { pose, animation };
}
const revisions = (pose: Pose) =>
  pose.nodes.map((node) => [node.worldRevision, node.weightsRevision]);

test('weighted layers blend TRS and morphs with authored fallbacks and normalized totals', () => {
  const { pose, animation } = player();
  animation.setPlaying(false);
  animation.setLayers([
    { clip: 0, time: 1, weight: 0.5 },
    { clip: 1, time: 2, weight: 0.5 },
  ]);
  animation.update(0);
  expect(pose.nodes[0].weights[0]).toBeCloseTo(0.5);
  expect(pose.nodes[3].weights[0]).toBeCloseTo(0.875);
  expect(pose.nodes[2].rotation[2]).toBeCloseTo(Math.sin(Math.PI / 8));
  expect(pose.nodes[2].rotation[3]).toBeCloseTo(Math.cos(Math.PI / 8));
  const before = revisions(pose);
  animation.setLayers([
    { clip: 0, time: 1, weight: 2 },
    { clip: 1, time: 2, weight: 2 },
  ]);
  expect(animation.update(0)).toBe(false);
  expect(revisions(pose)).toEqual(before);
  animation.setLayers([{ clip: 2, time: 2, weight: 0.25 }]);
  animation.update(0);
  expect(pose.nodes[3].translation[0]).toBe(2.25);
  expect(pose.nodes[3].weights[0]).toBe(0.75);
  animation.setLayers([]);
  animation.update(0);
  expect(pose.nodes[3].translation[0]).toBe(2);
});

test('crossfades advance both clocks, freeze when paused, and end at the destination', () => {
  const { pose, animation } = player();
  animation.seek(0.5);
  animation.update(500);
  animation.crossFadeTo(1, 1);
  expect(animation.update(1000)).toBe(false); // Starts exactly at outgoing pose.
  animation.update(1500);
  expect(animation.state.transition?.progress).toBe(0.5);
  expect(pose.nodes[0].weights[0]).toBeCloseTo(0.125); // Target sampled at .5s.
  expect(pose.nodes[2].rotation[2]).toBeCloseTo(Math.sin(Math.PI / 8)); // Source at 1s, half influence.
  animation.setPlaying(false);
  expect(animation.update(2000)).toBe(false);
  expect(animation.state.transition?.progress).toBe(0.5);
  animation.setPlaying(true);
  animation.update(9000);
  expect(animation.state.time).toBe(0.5);
  animation.update(9500);
  expect(animation.state.transition).toBeUndefined();
  expect(animation.state.time).toBe(1);
  expect(pose.nodes[0].weights[0]).toBe(0.5);
  expect(pose.nodes[2].rotation).toEqual([0, 0, 0, 1]);
});

test('interrupted fades retain the displayed pose and can fade back to authored defaults', () => {
  const { pose, animation } = player();
  animation.seek(1);
  animation.update(0);
  animation.crossFadeTo(1, 2);
  animation.update(0);
  animation.update(500);
  const before = pose.capture();
  animation.crossFadeTo(2, 1);
  expect(animation.update(500)).toBe(false);
  expect(pose.capture()).toEqual(before);
  animation.update(1000);
  expect(pose.nodes[0].weights[0]).toBeCloseTo(before[0].weights[0] / 2);
  expect(pose.nodes[3].translation[0]).toBeCloseTo(2.125);
  animation.crossFadeTo(-1, 1);
  animation.update(1000);
  animation.update(2000);
  expect(pose.nodes[3].translation).toEqual([2, 0, 0]);
  expect(pose.nodes[0].weights).toEqual([0]);
  expect(animation.state.clip).toBe(-1);
  expect(animation.update(3000)).toBe(false);
});

test('blend weights do not dirty unaffected nodes, zero-weight tracks, or equivalent quaternions', () => {
  const { pose, animation } = player();
  const before = revisions(pose);
  for (const weight of [0.1, 0.3, 0.7, 1]) {
    animation.setLayers([
      { clip: 0, time: 0, weight },
      { clip: 1, time: 2, weight: 0 },
    ]);
    expect(animation.update(0)).toBe(false);
  }
  expect(revisions(pose)).toEqual(before);
  pose.clips[0].tracks[0].values = [0, 0, 0, -1, 0, 0, 0, -1];
  animation.setLayers([{ clip: 0, time: 1, weight: 0.5 }]);
  expect(animation.update(0)).toBe(false);
  expect(revisions(pose)).toEqual(before);
});

test('layer clocks loop independently, input/state copies are isolated, and validation is atomic', () => {
  const { pose, animation } = player();
  const layers = [
    { clip: 1, time: 1.5, weight: 0.5 },
    { clip: 2, time: 0, weight: 0.5 },
  ];
  animation.setLayers(layers);
  layers[0].weight = 0;
  animation.update(0);
  animation.update(750);
  expect(animation.state.layers.map((layer) => layer.time)).toEqual([0.25, 0.75]);
  const state = animation.state;
  (state.layers[0] as { weight: number }).weight = 100;
  expect(animation.state.layers[0].weight).toBe(0.5);
  const before = animation.state;
  for (const layer of [
    { clip: 99, time: 0, weight: 1 },
    { clip: 0, time: NaN, weight: 1 },
    { clip: 0, time: 0, weight: -1 },
    { clip: 0, time: 0, weight: Infinity },
  ])
    expect(() => animation.setLayers([layer])).toThrow();
  expect(() => animation.crossFadeTo(1, -1)).toThrow();
  expect(() => animation.crossFadeTo(99, 1)).toThrow();
  expect(animation.state).toEqual(before);
  animation.crossFadeTo(0, 1);
  animation.seek(1);
  expect(animation.state.transition).toBeUndefined();
  animation.setPlaying(false);
  animation.update(0);
  expect(pose.nodes[2].rotation[2]).toBeCloseTo(Math.SQRT1_2);
  animation.crossFadeTo(1, 0);
  expect(animation.state.clip).toBe(1);
  expect(animation.state.transition).toBeUndefined();
  animation.crossFadeTo(0, 1);
  const replacement = animatedAsset();
  delete replacement.gltf.animations;
  animation.setPose(new Pose(replacement));
  expect(animation.state.transition).toBeUndefined();
  expect(animation.state.layers).toEqual([{ clip: -1, time: 0, weight: 1 }]);
});

test('rotation mixing takes the short arc across quaternion signs and scale uses linear weights', () => {
  const { pose, animation } = player();
  const rotation = pose.clips[0].tracks[0];
  // The incoming quaternion represents +20 degrees with the opposite sign.
  const angle = Math.PI / 18;
  rotation.values = [
    0,
    0,
    -Math.sin(angle),
    -Math.cos(angle),
    0,
    0,
    -Math.sin(angle),
    -Math.cos(angle),
  ];
  animation.setPlaying(false);
  animation.setLayers([{ clip: 0, time: 1, weight: 0.5 }]);
  animation.update(0);
  expect(pose.nodes[2].rotation[2]).toBeCloseTo(Math.sin(angle / 2));
  expect(pose.nodes[2].rotation[3]).toBeCloseTo(Math.cos(angle / 2));
  const scale = pose.clips[2].tracks[0];
  scale.path = 'scale';
  scale.values = [1, 2, 3, 3, 4, 5];
  animation.setLayers([{ clip: 2, time: 2, weight: 0.25 }]);
  animation.update(0);
  expect(pose.nodes[3].scale).toEqual([1.5, 1.75, 2]);
});
