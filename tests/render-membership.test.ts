import { expect, test, vi } from 'vitest';
import { InstanceSlots } from '../src/engine/rendering/instance-slots';
import {
  captureWorldRenderSnapshot,
  planWorldMembership,
  validateWorldRenderSnapshot,
} from '../src/engine/rendering/world-snapshot';
import { World } from '../src/engine/world';
import { ModelLibrary } from '../src/engine/model';
import { animatedAsset } from './fixtures/animated';
import { Resources, SharedResources } from '../src/renderer/core/resources';

test('slot candidates preserve survivors, reuse coalesced holes and reject stale handles', () => {
  const slots = new InstanceSlots();
  const a = slots.allocate(2),
    b = slots.allocate(3),
    c = slots.allocate(2);
  const candidate = slots.clone();
  candidate.release(b);
  const next = candidate.allocate(2);
  expect(next.firstInstance).toBe(b.firstInstance);
  expect(next.id).not.toBe(b.id);
  expect(slots.requiredCapacity).toBe(7); // Candidate cannot edit the live allocator.
  expect(() => candidate.release(b)).toThrow('Stale');
  candidate.release(next);
  candidate.release(c);
  expect(candidate.requiredCapacity).toBe(2);
  expect(candidate.allocate(5).firstInstance).toBe(2);
  expect(a.firstInstance).toBe(0);
  expect(Object.isFrozen(a)).toBe(true);
  expect(() => slots.allocate(0)).toThrow();
  expect(() => slots.allocate(1.5)).toThrow();
});

test('render snapshots expose model membership and reject structural edits across preparation', () => {
  const world = new World();
  world.createEntity({ id: 'group' });
  const snapshot = captureWorldRenderSnapshot(world);
  expect(snapshot.models).toEqual([]);
  world.getEntity('group').setTransform({ translation: [1, 0, 0] });
  validateWorldRenderSnapshot(snapshot);
  world.createEntity({ id: 'spawn' });
  expect(() => validateWorldRenderSnapshot(snapshot)).toThrow('structure changed');
});

test('retained private resources survive failed candidates and release once at their last lease', () => {
  const lifetime = new SharedResources();
  const destroy = vi.fn();
  lifetime.resources.own({ destroy } as unknown as GPUBuffer);
  const active = new Resources(),
    failed = new Resources(),
    next = new Resources();
  lifetime.retain(active);
  lifetime.retain(failed);
  failed.destroy();
  expect(destroy).not.toHaveBeenCalled();
  lifetime.retain(next);
  active.destroy();
  expect(destroy).not.toHaveBeenCalled();
  next.destroy();
  next.destroy();
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(() => lifetime.retain(new Resources())).toThrow('released');
});

test('membership diffs distinguish reused entity IDs from retained model instances', () => {
  const models = new ModelLibrary();
  models.register('hero', animatedAsset(), 'hero.glb');
  const world = new World(models);
  const old = world.createEntity({ id: 'reused', model: { asset: 'hero' } }).model!;
  const survivor = world.createEntity({ id: 'survivor', model: { asset: 'hero' } }).model!;
  world.destroyEntity('reused');
  const replacement = world.createEntity({ id: 'reused', model: { asset: 'hero' } }).model!;
  const plan = planWorldMembership(captureWorldRenderSnapshot(world), [old, survivor]);
  expect(plan.added).toEqual([replacement]);
  expect(plan.removed).toEqual([old]);
  expect(plan.models).toEqual([survivor, replacement]);
});
