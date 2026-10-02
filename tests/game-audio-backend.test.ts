import { afterEach, expect, test, vi } from 'vitest';
import { GameTools } from '../src/game/tools';
import { createLevel } from '../src/game/level';
import { CharacterSimulation } from '../src/game/simulation';
import { ActionInput } from '../src/engine/input/actions';
import { EngineRuntime } from '../src/engine/runtime/runtime';
import type { CheckpointPhysicsAdapter } from '../src/engine/physics/contracts';
import type { PcmAudioBackend } from '../src/engine/audio/audio-scene';
import type { Renderer } from '../src/renderer/renderer';

afterEach(() => vi.unstubAllGlobals());
test('audio factory is gesture-driven and a pending backend failure cannot release disposed ownership twice', async () => {
  const elements = new Map(
    ['#save', '#load', '#audio', '#save-status'].map((id) => [
      id,
      Object.assign(new EventTarget(), { textContent: '' }),
    ]),
  );
  vi.stubGlobal('document', { querySelector: (id: string) => elements.get(id) });
  const physics: CheckpointPhysicsAdapter = {
    addBox() {},
    step() {},
    destroy() {},
    createCharacter: (position) => ({
      position,
      grounded: true,
      move() {},
      destroy() {},
      checkpoint: () => ({ position, grounded: true, verticalVelocity: 0 }),
      restore() {},
    }),
  };
  const world = createLevel(physics);
  const simulation = new CharacterSimulation(world, physics, new ActionInput());
  const runtime = new EngineRuntime(world);
  let reject!: (error: Error) => void;
  const resumed = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const emitter = { setPosition: vi.fn(), play: vi.fn(), stop: vi.fn(), destroy: vi.fn() };
  const backend: PcmAudioBackend = {
    registerPCM: vi.fn(),
    createEmitter: vi.fn(() => emitter),
    setListener: vi.fn(),
    resume: vi.fn(() => resumed),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  const createAudio = vi.fn(() => backend);
  const tools = new GameTools(world, runtime, {} as Renderer, simulation, () => false, createAudio);
  expect(createAudio).not.toHaveBeenCalled();
  elements.get('#audio')!.dispatchEvent(new Event('click'));
  expect(createAudio).toHaveBeenCalledTimes(1);
  expect(backend.registerPCM).toHaveBeenCalledWith('step', expect.any(Float32Array));
  expect(backend.createEmitter).toHaveBeenCalledWith('step', 1);
  tools.destroy();
  tools.destroy();
  reject(new Error('Late resume failure'));
  await Promise.resolve();
  await Promise.resolve();
  expect(backend.destroy).toHaveBeenCalledTimes(1);
  expect(emitter.destroy).toHaveBeenCalledTimes(1);
  expect(elements.get('#save-status')!.textContent).toBe('');
  elements.get('#audio')!.dispatchEvent(new Event('click'));
  expect(createAudio).toHaveBeenCalledTimes(1);
  runtime.destroy();
  simulation.destroy();
  world.models.destroy();
});
