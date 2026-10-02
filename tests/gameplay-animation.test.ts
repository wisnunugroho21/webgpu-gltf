import { expect, test } from 'vitest';
import { AnimationController } from '../src/animation/controller';
import { Pose } from '../src/scene/pose';
import { animatedAsset } from './fixtures/animated';
import { characterAsset } from '../src/game/assets';
import { materialUniform } from '../src/renderer/materials/uniform';
import {
  materialLayoutVersion,
  materialUniformByteSize,
  materialFactorFloats,
} from '../src/renderer/materials/slots';
import { CharacterSimulation } from '../src/game/simulation';
import { createLevel } from '../src/game/level';
import { RapierPhysics } from '../src/engine/physics/rapier';
import { ActionInput } from '../src/engine/input/actions';
import { EngineRuntime } from '../src/engine/runtime/runtime';
import { crossedEvents } from '../src/animation/motion';

function player() {
  const pose = new Pose(characterAsset()),
    animation = new AnimationController();
  animation.setPose(pose);
  animation.setClock('external');
  animation.update(0);
  return { pose, animation };
}

test('node masks blend independently and restore masked-out targets without touching other nodes', () => {
  const pose = new Pose(animatedAsset());
  pose.evaluateBlend([{ clip: 1, time: 1, weight: 1, mask: [0] }]);
  expect(pose.nodes[0].weights[0]).toBe(0.5);
  expect(pose.nodes[3].weights[0]).toBe(0.75);
  const revision = pose.nodes[2].worldRevision;
  pose.evaluateBlend([{ clip: 1, time: 1, weight: 1, mask: [3] }]);
  expect(pose.nodes[0].weights[0]).toBe(0);
  expect(pose.nodes[3].weights[0]).toBe(0.5);
  expect(pose.nodes[2].worldRevision).toBe(revision);
  expect(() => pose.evaluateBlend([{ clip: 0, time: 0, weight: 1, mask: [99] }])).toThrow('mask');
});

test('additive aim stays outside interrupted snapshots, node overrides and shared clip data', () => {
  const { pose, animation } = player();
  const shared = JSON.stringify(pose.clips);
  animation.select(1);
  animation.advance(0.2);
  animation.setOverlays([
    { clip: 3, time: 0.5, speed: 0, weight: 1, additive: true, mask: [3, 4] },
  ]);
  animation.advance(0);
  const legs = [...pose.nodes[5].rotation],
    arm = [...pose.nodes[3].rotation];
  pose.setNodeTransform(2, { rotation: [0, 0, 0.7071068, 0.7071068] });
  animation.crossFadeTo(2, 0.4);
  animation.advance(0.1);
  const displayed = pose.capture();
  animation.crossFadeTo(0, 0.4);
  animation.advance(0);
  const interrupted = pose.capture();
  for (let i = 0; i < displayed.length; i++)
    displayed[i].rotation.forEach((value, c) =>
      expect(interrupted[i].rotation[c]).toBeCloseTo(value, 12),
    );
  animation.setOverlays([]);
  animation.advance(0);
  expect(pose.nodes[3].rotation).not.toEqual(arm);
  expect(pose.getNodeOverride(2).rotation).toBeDefined();
  pose.clearNodeTransform(2);
  expect(pose.nodes[2].rotation).toEqual([0, 0, 0, 1]);
  expect(JSON.stringify(pose.clips)).toBe(shared);
  expect(legs).not.toEqual([0, 0, 0, 1]);
});

test('events cross loops once, preserve chronological order, and seek/pause never synthesize events', () => {
  const { animation } = player();
  animation.select(1);
  animation.advance(2.8);
  const events = animation.drainEvents();
  expect(events.map((event) => event.name)).toEqual([
    'foot-left',
    'foot-right',
    'foot-left',
    'foot-right',
    'foot-left',
    'foot-right',
  ]);
  expect(events.map((event) => event.elapsedSeconds)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);
  expect(animation.drainEvents()).toEqual([]);
  animation.advance(0);
  expect(animation.drainEvents()).toEqual([]);
  animation.seek(0.5);
  animation.advance(0);
  expect(animation.drainEvents()).toEqual([]);
  animation.setPlaying(false);
  animation.advance(20);
  expect(animation.drainEvents()).toEqual([]);
  animation.setPlaying(true);
  animation.advance(0.25);
  expect(animation.drainEvents()).toHaveLength(1);
});

test('fading event names/timestamps/weights are independent of catch-up partitioning', () => {
  const collect = (steps: number) => {
    const { animation } = player();
    animation.select(1);
    animation.crossFadeTo(2, 0.5);
    for (let i = 0; i < steps; i++) animation.advance(1 / steps);
    return animation.drainEvents();
  };
  const coarse = collect(1),
    fine = collect(60);
  expect(coarse.map((event) => [event.clip, event.name])).toEqual(
    fine.map((event) => [event.clip, event.name]),
  );
  coarse.forEach((event, i) => {
    expect(event.elapsedSeconds).toBeCloseTo(fine[i].elapsedSeconds, 9);
    expect(event.weight).toBeCloseTo(fine[i].weight, 9);
  });
  expect(coarse.filter((event) => event.clip === 1).map((event) => event.name)).toEqual([
    'foot-left',
  ]);
});

test('root motion survives loops, is consumed once, stays in place and does not move physics roots itself', () => {
  const { animation, pose } = player();
  animation.select(1);
  animation.setRootMotion({ node: 0, mode: 'extract' });
  animation.advance(2.4);
  expect(animation.consumeRootMotion()[2]).toBeCloseTo(6, 6);
  expect(animation.consumeRootMotion()).toEqual([0, 0, 0]);
  expect(pose.nodes[0].translation).toEqual([0, 0, 0]);
  animation.update(99999);
  expect(animation.consumeRootMotion()).toEqual([0, 0, 0]);
  animation.seek(0.5);
  animation.advance(0);
  expect(animation.consumeRootMotion()).toEqual([0, 0, 0]);
  animation.setRootMotion({ node: 0, mode: 'in-place' });
  animation.advance(1);
  expect(animation.consumeRootMotion()).toEqual([0, 0, 0]);
  expect(pose.nodes[0].translation).toEqual([0, 0, 0]);
  expect(() => animation.setRootMotion({ node: 3, mode: 'extract' })).toThrow('root TRS');
});

test('external clock and root-motion physics produce identical trajectories and events at multiple render rates', async () => {
  const results = [];
  for (const hz of [30, 144]) {
    const physics = await RapierPhysics.create(),
      world = createLevel(physics),
      input = new ActionInput();
    const simulation = new CharacterSimulation(world, physics, input);
    simulation.rootMotionEnabled = true;
    physics.step(1 / 60);
    input.set('right', true);
    input.set('aim', true);
    const runtime = new EngineRuntime(world, {}, { systems: simulation.systems });
    runtime.advance(0);
    for (let frame = 1; frame <= hz * 2; frame++) runtime.advance((frame * 1000) / hz);
    const entity = world.getEntity('player');
    results.push({
      position: simulation.body.position,
      footfalls: simulation.footfalls,
      time: entity.model!.animation.state.time,
    });
    expect(entity.model!.pose.nodes[0].translation).toEqual([0, 0, 0]);
    expect(entity.transformOwner).toBe('physics');
    runtime.destroy();
    physics.destroy();
    world.models.destroy();
  }
  expect(results[0]).toEqual(results[1]);
  expect(results[0].footfalls).toBeGreaterThan(0);
});

test('masked base transitions preserve their starting pose and dense event intervals reject safely', () => {
  const { animation, pose } = player();
  animation.setLayers([
    { clip: 1, time: 0.3, weight: 2, mask: [3, 4] },
    { clip: 2, time: 0.2, weight: 1, mask: [5, 6] },
  ]);
  animation.advance(0);
  const before = pose.capture();
  animation.crossFadeTo(0, 0.5);
  animation.advance(0);
  expect(pose.capture()).toEqual(before);
  expect(() =>
    crossedEvents(
      { name: 'dense', duration: 0.001, tracks: [], events: [{ time: 0, name: 'tick' }] },
      0,
      0,
      100,
      1,
    ),
  ).toThrow('4096');
});

test('toon schema migrates uniforms together, retains neutral slots and validates authored values', () => {
  expect(materialLayoutVersion).toBe(2);
  expect(materialFactorFloats).toBe(44);
  expect(materialUniformByteSize).toBe(560);
  const plain = materialUniform({}),
    toon = materialUniform({ extras: { engine: { toon: { outlineWidth: 3 } } } });
  expect(plain[32]).toBe(0);
  expect(toon[32]).toBe(1);
  expect(toon[43]).toBe(3);
  expect(plain.slice(44)).toEqual(toon.slice(44));
  for (const policy of [
    { threshold: 2 },
    { softness: 0 },
    { outlineWidth: -1 },
    { shadowColor: [1, 1] },
    { indirectStrength: NaN },
  ])
    expect(() => materialUniform({ extras: { engine: { toon: policy } } })).toThrow();
});
