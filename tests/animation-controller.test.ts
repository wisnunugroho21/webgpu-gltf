import { describe, expect, it } from 'vitest';
import { AnimationController } from '../src/animation/controller';
import { Pose } from '../src/scene/pose';
import { animatedAsset } from './fixtures/animated';

function player() {
  const pose = new Pose(animatedAsset());
  const animation = new AnimationController();
  animation.setPose(pose);
  return { animation, pose };
}

describe('animation playback controller', () => {
  it('uses frame timestamps in milliseconds and loops in seconds', () => {
    const { animation } = player();
    expect(animation.state.clip).toBe(0);
    expect(animation.update(0)).toBe(true);
    animation.update(500);
    expect(animation.state.time).toBe(0.5);
    animation.update(2500);
    expect(animation.state.time).toBe(0.5);
  });

  it('keeps paused poses idle and excludes paused wall time on resume', () => {
    const { animation } = player();
    animation.update(1000);
    animation.update(1500);
    animation.setPlaying(false);
    expect(animation.update(3000)).toBe(false);
    animation.setPlaying(true);
    animation.update(9000);
    expect(animation.state.time).toBe(0.5);
    animation.update(9500);
    expect(animation.state.time).toBe(1);
  });

  it('evaluates seeks while paused, clamps endpoints, and restores authored defaults', () => {
    const { animation, pose } = player();
    animation.setPlaying(false);
    animation.select(1);
    animation.seek(10);
    expect(animation.update(0)).toBe(true);
    expect(animation.state.time).toBe(2);
    expect(pose.nodes[0].weights).toEqual([1]);
    expect(animation.update(1000)).toBe(false);
    animation.seek(-1);
    animation.update(2000);
    expect(pose.nodes[0].weights).toEqual([0]);
    animation.select(-1);
    animation.update(3000);
    expect(pose.nodes[3].weights).toEqual([0.75]);
    expect(animation.update(4000)).toBe(false);
  });

  it('resets playback on replacement and evaluates static authored poses only once', () => {
    const { animation } = player();
    animation.select(1);
    animation.seek(1.5);
    animation.setPlaying(false);
    const asset = animatedAsset();
    delete asset.gltf.animations;
    const pose = new Pose(asset);
    animation.setPose(pose);
    expect(animation.state).toEqual({
      clips: [],
      clip: -1,
      time: 0,
      playing: true,
      duration: 0,
      layers: [{ clip: -1, time: 0, weight: 1 }],
      overlays: [],
      clock: 'presentation',
      transition: undefined,
    });
    expect(animation.update(1000)).toBe(true);
    expect(animation.update(2000)).toBe(false);
    expect(pose.nodes[3].weights).toEqual([0.75]);
  });

  it('notifies controls after state changes and rejects invalid requests without changing state', () => {
    const { animation } = player();
    const times: number[] = [];
    animation.onChange = () => times.push(animation.state.time);
    animation.select(1);
    animation.seek(0.5);
    animation.setPlaying(false);
    animation.update(0);
    expect(times).toEqual([0, 0.5, 0.5, 0.5]);
    const before = animation.state;
    for (const clip of [100, -2, 0.5, NaN]) expect(() => animation.select(clip)).toThrow('clip');
    expect(() => animation.seek(Infinity)).toThrow('finite');
    expect(animation.state).toEqual(before);
  });

  it('advances and notifies through STEP holds without requesting pose uploads, including repeated seeks and looped values', () => {
    const asset = animatedAsset();
    asset.gltf.animations![0].samplers[0].interpolation = 'STEP';
    const pose = new Pose(asset),
      animation = new AnimationController();
    animation.setPose(pose);
    expect(animation.update(0)).toBe(true); // First GPU output is still required.
    const times: number[] = [];
    animation.onChange = () => times.push(animation.state.time);
    expect(animation.update(500)).toBe(false);
    expect(animation.update(1500)).toBe(false);
    expect(animation.update(2500)).toBe(false); // Loops to the same STEP value.
    expect(times).toEqual([0.5, 1.5, 0.5]);
    animation.setPlaying(false);
    animation.seek(2);
    expect(animation.update(3000)).toBe(true);
    animation.seek(2);
    expect(animation.update(3500)).toBe(false);
    animation.select(-1);
    expect(animation.update(4000)).toBe(true);
    expect(animation.update(4500)).toBe(false);
  });
});
