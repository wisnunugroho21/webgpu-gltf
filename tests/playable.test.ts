import { describe, expect, it } from 'vitest';
import { ActionInput } from '../src/engine/input/actions';
import { RapierPhysics } from '../src/engine/physics/rapier';
import { writePhysicsPosition } from '../src/engine/physics/entity-pose';
import { EngineRuntime } from '../src/engine/runtime/runtime';
import { World } from '../src/engine/world';
import { movement, Locomotion } from '../src/game/locomotion';
import { createLevel } from '../src/game/level';

describe('action input boundaries', () => {
  it('retains a tap until a simulation step and consumes edges exactly once', () => {
    const input = new ActionInput();
    input.set('jump', true);
    input.set('jump', false);
    expect(input.consume().get('jump')).toEqual({ held: false, pressed: true, released: true });
    expect(input.consume().get('jump')).toEqual({ held: false, pressed: false, released: false });
  });
  it('supports aliases and ignores repeated keydown', () => {
    const input = new ActionInput();
    input.set('forward', true, 'W');
    input.consume();
    input.set('forward', true, 'W');
    input.set('forward', true, 'Up');
    input.set('forward', false, 'W');
    expect(input.consume().get('forward')).toEqual({ held: true, pressed: false, released: false });
    input.clear();
    expect(input.consume().size).toBe(0);
  });
  it('normalizes diagonals and does not repeat jump edges on catch-up steps', () => {
    const input = new ActionInput();
    input.set('forward', true);
    input.set('right', true);
    input.set('jump', true);
    const first = movement(input.consume());
    expect(Math.hypot(first.x, first.z)).toBeCloseTo(2.5);
    expect(first.jump).toBe(true);
    expect(movement(input.consume()).jump).toBe(false);
  });
});

describe('fixed-step Rapier integration', () => {
  it('produces the same movement at 30, 60 and 144 render Hz', async () => {
    const positions = [];
    for (const hz of [30, 60, 144]) {
      const physics = await RapierPhysics.create();
      physics.addBox([0, -0.25, 0], [20, 0.25, 20]);
      const body = physics.createCharacter([0, 0.02, 0]);
      physics.step(1 / 60);
      const runtime = new EngineRuntime(new World(), {
        gameplay: (step) => body.move({ x: 2.5, z: 0, jump: false }, step.deltaSeconds),
        physics: (step) => physics.step(step.deltaSeconds),
      });
      runtime.advance(0);
      for (let frame = 1; frame <= hz * 2; frame++) runtime.advance((frame * 1000) / hz);
      positions.push(body.position);
      expect(body.grounded).toBe(true);
      runtime.destroy();
      body.destroy();
      physics.destroy();
    }
    // Collision correction may reduce requested speed slightly; render rate must
    // still have no effect on the accepted fixed-step trajectory.
    expect(positions[0][0]).toBeGreaterThan(4.5);
    expect(positions[1]).toEqual(positions[0]);
    expect(positions[2]).toEqual(positions[0]);
  });
  it('blocks walls, lands after a jump, and rejects use after teardown', async () => {
    const physics = await RapierPhysics.create();
    physics.addBox([0, -0.25, 0], [10, 0.25, 10]);
    physics.addBox([2, 1, 0], [0.25, 1, 3]);
    const body = physics.createCharacter([0, 0.02, 0]);
    physics.step(1 / 60);
    for (let i = 0; i < 120; i++) {
      body.move({ x: 3, z: 0, jump: false }, 1 / 60);
      physics.step(1 / 60);
    }
    expect(body.position[0]).toBeLessThan(1.42);
    expect(body.grounded).toBe(true);
    body.move({ x: 0, z: 0, jump: true }, 1 / 60);
    physics.step(1 / 60);
    expect(body.position[1]).toBeGreaterThan(0.05);
    for (let i = 0; i < 100; i++) {
      body.move({ x: 0, z: 0, jump: false }, 1 / 60);
      physics.step(1 / 60);
    }
    expect(body.grounded).toBe(true);
    expect(body.position[1]).toBeLessThan(0.03);
    body.destroy();
    body.destroy();
    physics.destroy();
    physics.destroy();
    expect(() => physics.step(1 / 60)).toThrow('disposed');
  });
  it('climbs the authored steps and releases removed characters', async () => {
    const physics = await RapierPhysics.create();
    physics.addBox([0, -0.25, 0], [10, 0.25, 10]);
    physics.addBox([0, 0.1, -1], [1, 0.1, 1]);
    const body = physics.createCharacter([0, 0.02, 2]);
    physics.step(1 / 60);
    for (let i = 0; i < 60; i++) {
      body.move({ x: 0, z: -2.5, jump: false }, 1 / 60);
      physics.step(1 / 60);
    }
    expect(body.position[2]).toBeLessThan(0);
    expect(body.position[1]).toBeGreaterThan(0.18);
    body.destroy();
    expect(() => body.move({ x: 0, z: 0, jump: false }, 1 / 60)).toThrow('disposed');
    physics.destroy();
  });
  it('does not simulate suspension time or consume input on paused/no-step frames', () => {
    const input = new ActionInput();
    let jumps = 0,
      steps = 0;
    const runtime = new EngineRuntime(new World(), {
      gameplay() {
        steps++;
        if (movement(input.consume()).jump) jumps++;
      },
    });
    runtime.advance(0);
    input.set('jump', true);
    runtime.advance(1);
    expect(jumps).toBe(0);
    runtime.advance(50);
    expect(jumps).toBe(1);
    expect(steps).toBe(3);
    runtime.pause();
    input.clear();
    runtime.advance(60_000);
    runtime.resume();
    runtime.advance(120_000);
    expect(steps).toBe(3);
    runtime.advance(120_017);
    expect(steps).toBe(4);
    runtime.destroy();
  });
});

it('converts global physics positions into rotated/scaled parent-local roots and preserves ownership', () => {
  const world = new World();
  const parent = world.createEntity({
    id: 'parent',
    transform: {
      translation: [10, 2, 0],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      scale: [2, 2, 2],
    },
  });
  const child = world.createEntity({ id: 'child', parent: 'parent', transformOwner: 'physics' });
  world.updateTransforms();
  writePhysicsPosition(child, [12, 4, 6], parent);
  world.updateTransforms();
  expect([...child.worldMatrix].slice(12, 15)).toEqual([12, 4, 6]);
  expect(world.getParent('child')).toBe(parent);
  parent.setTransform({ translation: [20, 2, 0] });
  world.updateTransforms();
  writePhysicsPosition(child, [12, 4, 6], world.getParent('child'));
  world.updateTransforms();
  expect([...child.worldMatrix].slice(12, 15)).toEqual([12, 4, 6]);
  world.setParent('child');
  world.updateTransforms();
  expect(world.getParent('child')).toBeUndefined();
  writePhysicsPosition(child, [12, 4, 6], world.getParent('child'));
  expect(child.transform.translation).toEqual([12, 4, 6]);
  expect(() => child.setTransform({ translation: [0, 0, 0] })).toThrow('owned by physics');
  child.setTransformOwner('gameplay');
  expect(() => writePhysicsPosition(child, [0, 0, 0])).toThrow('owned by gameplay');
});

it('shares character resources but retains independent clips, poses and state transitions', async () => {
  const physics = await RapierPhysics.create();
  const world = createLevel(physics);
  const player = world.getEntity('player').model!,
    other = world.getEntity('companion').model!;
  expect(player.resources).toBe(other.resources);
  expect(player.pose).not.toBe(other.pose);
  const motion = new Locomotion(player.animation);
  motion.update(2.5);
  world.update(100);
  world.update(200);
  const time = player.animation.state.time;
  motion.update(2.5);
  expect(player.animation.state.time).toBe(time);
  motion.update(5);
  expect(motion.state).toBe('Run');
  world.destroyEntity('companion');
  expect(world.getEntity('player').model).toBe(player);
  physics.destroy();
  world.models.destroy();
});
