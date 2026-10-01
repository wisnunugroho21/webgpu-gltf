import { expect, test } from 'vitest';
import { Pose } from '../src/scene/pose';
import { PoseMixer, clonePose } from '../src/animation/blending';
import { animatedAsset } from './fixtures/animated';

test('sparse mixing matches full mixing across switches, blends and snapshots', () => {
  const asset = animatedAsset();
  for (let i = 0; i < 2048; i++) asset.gltf.nodes!.push({ translation: [i, 0, 0] });
  const pose = new Pose(asset);
  pose.profiling = true;
  const defaults = pose.capture();
  const mixer = new PoseMixer(defaults, pose.clips);
  const full = clonePose(defaults);
  for (const samples of [
    [{ clip: 0, time: 1, weight: 1 }],
    [{ clip: 0, time: 1.5, weight: 1 }],
    [{ clip: 2, time: 1, weight: 1 }],
    [{ clip: 2, time: 1.5, weight: 1 }],
    [
      { clip: 1, time: 1, weight: 0.4 },
      { clip: 2, time: 2, weight: 0.6 },
    ],
    [],
  ]) {
    mixer.evaluate(samples, full);
    pose.evaluateBlend(samples);
    expect(pose.capture()).toEqual(full);
    expect(pose.timings.visitedNodes).toBeLessThanOrEqual(3);
  }
  pose.evaluate(0, 1);
  const snapshot = pose.capture();
  const samples = [
    { pose: snapshot, weight: 0.7 },
    { clip: 1, time: 2, weight: 0.3 },
  ];
  mixer.evaluate(samples, full);
  pose.evaluateBlend(samples);
  expect(pose.capture()).toEqual(full);
  expect(pose.timings.visitedNodes).toBe(pose.nodes.length);
  pose.evaluate(-1, 0);
  expect(pose.capture()).toEqual(defaults);
  pose.evaluate(-1, 0);
  expect(pose.timings.visitedNodes).toBe(0);
});

test('animated ancestors visit descendants in parent order and retire old targets once', () => {
  const asset = animatedAsset();
  asset.gltf.animations![2].channels[0].target.node = 1;
  const pose = new Pose(asset);
  pose.profiling = true;
  expect([...pose.animatedWorld]).toEqual([0, 1, 1, 0]);
  pose.evaluate(2, 1);
  expect(pose.timings.sampledNodes).toBe(1);
  expect(pose.timings.visitedNodes).toBe(2);
  expect(pose.nodes[2].world[12]).toBe(2.5);
  const revision = pose.nodes[2].worldRevision;
  pose.evaluate(1, 1);
  expect(pose.nodes[2].world[12]).toBe(0);
  expect(pose.nodes[2].worldRevision).toBe(revision + 1);
  pose.evaluate(1, 1.5);
  expect(pose.timings.sampledNodes).toBe(2);
  expect(pose.timings.visitedNodes).toBe(2); // Weights need no descendants.
  expect(pose.nodes[2].worldRevision).toBe(revision + 1);
  pose.evaluateBlend([{ clip: 1, time: 2, weight: 0 }]);
  expect(pose.nodes[0].weights).toEqual([0]);
  pose.evaluateBlend([{ clip: 1, time: 2, weight: 0 }]);
  expect(pose.timings.sampledNodes).toBe(0);
});

test('invalid blend requests retain outgoing targets for restoration', () => {
  const pose = new Pose(animatedAsset());
  pose.evaluate(2, 2);
  expect(() => pose.evaluateBlend([{ clip: -1, time: 0, weight: NaN }])).toThrow();
  expect(pose.nodes[3].translation[0]).toBe(3);
  expect(pose.evaluate(-1, 0)).toBe(true);
  expect(pose.nodes[3].translation[0]).toBe(2);
});
