import { expect, test, vi } from 'vitest';
import { World, AudioScene, type AudioBackend, type AudioEmitter } from '../src/engine';
test('audio follows hierarchy and stops removed identities even when their ID is reused', () => {
  const emitter: AudioEmitter = {
    play: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    setPosition: vi.fn(),
  };
  const backend: AudioBackend = {
    createEmitter: vi.fn(() => emitter),
    setListener: vi.fn(),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  const world = new World();
  world.createEntity({ id: 'parent', transform: { translation: [2, 0, 0] } });
  const actor = world.createEntity({ id: 'actor', parent: 'parent' });
  const audio = new AudioScene(backend);
  audio.attach(actor, 'step');
  audio.setListener(actor);
  world.updateTransforms();
  audio.update(world);
  expect(emitter.setPosition).toHaveBeenLastCalledWith([2, 0, 0]);
  expect(backend.setListener).toHaveBeenLastCalledWith({
    position: [2, 0, 0],
    forward: [-0, -0, -1],
    up: [0, 1, 0],
  });
  world.getEntity('parent').setTransform({ translation: [3, 1, 0] });
  world.updateTransforms();
  audio.update(world);
  expect(emitter.setPosition).toHaveBeenLastCalledWith([3, 1, 0]);
  world.destroyEntity('actor');
  world.createEntity({ id: 'actor' });
  audio.update(world);
  audio.destroy();
  expect(emitter.destroy).toHaveBeenCalledTimes(1);
  expect(backend.destroy).not.toHaveBeenCalled();
});
