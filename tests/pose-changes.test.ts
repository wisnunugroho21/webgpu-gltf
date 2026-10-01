import { expect, test } from 'vitest';
import { Pose } from '../src/scene/pose';
import { animatedAsset } from './fixtures/animated';

const revisions = (pose: Pose) =>
  pose.nodes.map((node) => [node.worldRevision, node.weightsRevision]);

test('joint animation only changes the targeted subtree, and evaluating the same final pose stays idle', () => {
  const pose = new Pose(animatedAsset());
  const before = revisions(pose);
  expect(pose.evaluate(0, 0.5)).toBe(true);
  expect(pose.nodes[2].worldRevision).toBe(before[2][0] + 1);
  for (const i of [0, 1, 3]) expect(revisions(pose)[i]).toEqual(before[i]);
  const changed = revisions(pose);
  expect(pose.evaluate(0, 0.5)).toBe(false);
  expect(revisions(pose)).toEqual(changed);
});

test('STEP holds and constant LINEAR keys change neither matrices nor weight revisions as time advances', () => {
  const asset = animatedAsset();
  asset.gltf.animations![0].samplers[0].interpolation = 'STEP';
  const pose = new Pose(asset);
  expect(pose.evaluate(0, 0.2)).toBe(false);
  expect(pose.evaluate(0, 1.9)).toBe(false);
  expect(pose.evaluate(0, 2)).toBe(true);
  const held = revisions(pose);
  expect(pose.evaluate(0, 20)).toBe(false);
  expect(revisions(pose)).toEqual(held);
  const translation = pose.clips[2].tracks[0];
  translation.values = [2, 0, 0, 2, 0, 0];
  pose.evaluate(2, 0);
  const constant = revisions(pose);
  expect(pose.evaluate(2, 0.8)).toBe(false);
  expect(revisions(pose)).toEqual(constant);
});

test('parent transforms propagate to descendants but morph changes never dirty their world matrices', () => {
  const asset = animatedAsset();
  const pose = new Pose(asset);
  const parentTrack = pose.clips[2].tracks[0];
  parentTrack.node = 1;
  const before = revisions(pose);
  pose.evaluate(2, 0.5);
  expect(pose.nodes[1].worldRevision).toBe(before[1][0] + 1);
  expect(pose.nodes[2].worldRevision).toBe(before[2][0] + 1);
  expect(revisions(pose)[0]).toEqual(before[0]);
  expect(revisions(pose)[3]).toEqual(before[3]);
  pose.evaluate(-1, 0);
  const restored = revisions(pose);
  pose.evaluate(1, 1);
  expect(pose.nodes.map((n) => n.worldRevision)).toEqual(restored.map((r) => r[0]));
  expect(pose.nodes[0].weightsRevision).toBe(restored[0][1] + 1);
  expect(pose.nodes[3].weightsRevision).toBe(restored[3][1] + 1);
  expect(pose.nodes[2].weightsRevision).toBe(restored[2][1]);
});

test('clip switching compares restored defaults with the previous final pose and authored mode becomes idle', () => {
  const pose = new Pose(animatedAsset());
  pose.evaluate(2, 1);
  const translated = revisions(pose);
  pose.evaluate(0, 0);
  expect(pose.nodes[3].worldRevision).toBe(translated[3][0] + 1);
  for (const i of [0, 1, 2]) expect(revisions(pose)[i]).toEqual(translated[i]);
  expect(pose.evaluate(-1, 0)).toBe(false);
});

test('equivalent quaternion signs and changes cancelled by a collapsed parent preserve world revisions', () => {
  const asset = animatedAsset();
  asset.gltf.nodes![1].scale = [0, 0, 0];
  const pose = new Pose(asset);
  const before = revisions(pose);
  expect(pose.evaluate(0, 0.8)).toBe(false);
  expect(revisions(pose)).toEqual(before);
  const other = new Pose(animatedAsset());
  other.clips[0].tracks[0].values = [0, 0, 0, -1, 0, 0, 0, -1];
  expect(other.evaluate(0, 0.5)).toBe(false);
});
