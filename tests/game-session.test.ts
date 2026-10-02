import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AssetRegistry } from '../src/engine/assets/registry';
import { captureSaveState } from '../src/engine/serialization/save-state';
import { GameSession } from '../src/game/session';
import { createLevel } from '../src/game/level';
import { readPendingSave } from '../src/game/restore';
import type { GameElements } from '../src/game/controls';

// Keep real CPU worlds, poses and systems; substitute only browser services and
// backend lifetime boundaries so failure/cancellation can be controlled precisely.
const harness = vi.hoisted(() => ({
  physics: undefined as any,
  renderer: undefined as any,
  tools: undefined as any,
  createPhysics: vi.fn(),
  createRenderer: vi.fn(),
}));
vi.mock('../src/engine/physics/rapier', () => ({
  RapierPhysics: { create: harness.createPhysics },
}));
vi.mock('../src/renderer/renderer', () => ({ Renderer: { create: harness.createRenderer } }));
vi.mock('../src/game/tools', () => ({
  GameTools: vi.fn(function () {
    return harness.tools;
  }),
}));

class Control extends EventTarget {
  disabled = false;
  checked = false;
  textContent = '';
  focus = vi.fn();
  tabIndex = 0;
}
let view: GameElements;
let sessions: GameSession[];
let frames: Map<number, FrameRequestCallback>;
let storage: Map<string, string>;
let destroyAssets: ReturnType<typeof vi.spyOn>;
const start = () => {
  const session = new GameSession(view);
  sessions.push(session);
  return session;
};
beforeEach(() => {
  vi.clearAllMocks();
  sessions = [];
  frames = new Map();
  storage = new Map();
  view = Object.fromEntries(
    ['canvas', 'status', 'saveStatus', 'pause', 'companion', 'rootMotion'].map((key) => [
      key,
      new Control(),
    ]),
  ) as unknown as GameElements;
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  let id = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((frame: number) => frames.delete(frame)),
  );
  const body = {
    position: [0, 0.05, 3],
    grounded: true,
    move: vi.fn(),
    destroy: vi.fn(),
    checkpoint: vi.fn(),
    restore: vi.fn(),
  };
  harness.physics = {
    addBox: vi.fn(),
    createCharacter: vi.fn(() => body),
    step: vi.fn(),
    destroy: vi.fn(),
  };
  harness.renderer = {
    setWorld: vi.fn(async () => {}),
    syncWorld: vi.fn(async () => {}),
    render: vi.fn(() => true),
    recover: vi.fn(async () => {}),
    destroy: vi.fn(),
    aspectRatio: 1,
  };
  harness.tools = { update: vi.fn(), setPaused: vi.fn(), destroy: vi.fn() };
  harness.createPhysics.mockResolvedValue(harness.physics);
  harness.createRenderer.mockResolvedValue(harness.renderer);
  destroyAssets = vi.spyOn(AssetRegistry.prototype, 'destroy');
});
afterEach(() => {
  for (const session of sessions) session.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('session presents through the runtime and tears down initialized systems exactly once', async () => {
  const session = start();
  await session.start();
  const advance = (time: number) => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(time);
  };
  advance(0);
  advance(20);
  expect(harness.physics.createCharacter.mock.results[0].value.move).toHaveBeenCalled();
  expect(harness.renderer.render).toHaveBeenCalledTimes(2);
  expect(harness.tools.update).toHaveBeenCalledTimes(2);
  session.destroy();
  session.destroy();
  expect(harness.physics.createCharacter.mock.results[0].value.destroy).toHaveBeenCalledTimes(1);
  for (const resource of [harness.physics, harness.renderer, harness.tools])
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  expect(destroyAssets).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
  view.pause.dispatchEvent(new Event('click'));
  expect(view.canvas.focus).not.toHaveBeenCalled();
  expect(view.pause.disabled).toBe(true);
});

test('blocked pending-save storage still starts a fresh playable session', async () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('Storage blocked');
    },
  });
  await start().start();
  expect(view.saveStatus.textContent).toContain('Storage blocked');
  expect(harness.renderer.setWorld).toHaveBeenCalled();
  expect(view.pause.disabled).toBe(false);
});

test('pending save is consumed once; storage accessor/removal errors stay optional', () => {
  const report = vi.fn();
  storage.set('engine-game-pending', 'saved');
  expect(readPendingSave(report)).toBe('saved');
  expect(readPendingSave(report)).toBeUndefined();
  expect(
    readPendingSave(report, () => {
      throw new Error('Blocked accessor');
    }),
  ).toBeUndefined();
  expect(
    readPendingSave(report, () => ({
      getItem: () => 'saved',
      removeItem: () => {
        throw new Error('Blocked removal');
      },
    })),
  ).toBeUndefined();
  expect(report).toHaveBeenCalledTimes(2);
});

test.each(['physics', 'renderer', 'attachment'])(
  'startup failure at %s has one cleanup path',
  async (stage) => {
    const error = new Error(`Failed ${stage}`);
    if (stage === 'physics') harness.createPhysics.mockRejectedValue(error);
    if (stage === 'renderer') harness.createRenderer.mockRejectedValue(error);
    if (stage === 'attachment') harness.renderer.setWorld.mockRejectedValue(error);
    await expect(start().start()).rejects.toThrow(error.message);
    expect(view.status.textContent).toContain(error.message);
    expect(frames.size).toBe(0);
    expect(harness.physics.destroy).toHaveBeenCalledTimes(stage === 'physics' ? 0 : 1);
    expect(harness.renderer.destroy).toHaveBeenCalledTimes(stage === 'attachment' ? 1 : 0);
    expect(destroyAssets).toHaveBeenCalledTimes(stage === 'physics' ? 0 : 1);
  },
);

test('bad save JSON and invalid character gameplay release the registry and physics before GPU startup', async () => {
  storage.set('engine-game-pending', '{broken');
  await expect(start().start()).rejects.toThrow();
  expect(harness.physics.destroy).toHaveBeenCalledTimes(1);
  expect(destroyAssets).toHaveBeenCalledTimes(1);
  const world = createLevel(harness.physics);
  storage.set(
    'engine-game-pending',
    JSON.stringify(
      captureSaveState(world, undefined, {
        body: {},
        footfalls: -1,
        rootMotion: false,
        locomotion: 'Idle',
      }),
    ),
  );
  world.models.destroy();
  destroyAssets.mockClear();
  harness.physics.destroy.mockClear();
  await expect(start().start()).rejects.toThrow('Invalid saved character gameplay');
  expect(harness.physics.destroy).toHaveBeenCalledTimes(1);
  expect(destroyAssets).toHaveBeenCalledTimes(1);
  expect(harness.createRenderer).not.toHaveBeenCalled();
});

test.each(['physics', 'renderer'])(
  'disposal during pending %s startup releases late resources',
  async (stage) => {
    let resolve!: (resource: any) => void;
    const gate = new Promise((done) => {
      resolve = done;
    });
    const factory = stage === 'physics' ? harness.createPhysics : harness.createRenderer;
    factory.mockReturnValue(gate);
    const session = start(),
      pending = session.start();
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    session.destroy();
    resolve(stage === 'physics' ? harness.physics : harness.renderer);
    await expect(pending).rejects.toThrow('disposed during startup');
    expect(harness.physics.destroy).toHaveBeenCalledTimes(1);
    expect(harness.renderer.destroy).toHaveBeenCalledTimes(stage === 'renderer' ? 1 : 0);
    expect(frames.size).toBe(0);
  },
);

test('binding failure and a throwing cleanup hook still release all other resources', async () => {
  const document = globalThis.document;
  vi.spyOn(document, 'addEventListener').mockImplementation(() => {
    throw new Error('Binding failed');
  });
  harness.tools.destroy.mockImplementation(() => {
    throw new Error('Tool cleanup failed');
  });
  await expect(start().start()).rejects.toThrow('Game startup and cleanup failed');
  for (const resource of [harness.physics, harness.renderer, harness.tools])
    expect(resource.destroy).toHaveBeenCalledTimes(1);
  expect(destroyAssets).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
});

test('restored character playback survives system defaults before presentation starts', async () => {
  const world = createLevel(harness.physics);
  const animation = world.getEntity('player').model!.animation;
  animation.setClock('external');
  animation.select(2);
  animation.setRootMotion({ node: 0, mode: 'extract' });
  animation.advance(0.75);
  animation.setOverlays([{ clip: 3, time: 0.5, weight: 1, mask: [3, 4], additive: true }]);
  const saved = captureSaveState(world, undefined, {
    body: { position: [0, 0.05, 3], verticalVelocity: 0, grounded: true },
    footfalls: 7,
    rootMotion: true,
    locomotion: 'Run',
  });
  storage.set('engine-game-pending', JSON.stringify(saved));
  world.models.destroy();
  const session = start();
  await session.start();
  const restored = Reflect.get(session, 'world') as typeof world;
  expect(restored.getEntity('player').model!.animation.checkpoint()).toEqual(
    saved.models.player.animation,
  );
  expect(view.rootMotion.checked).toBe(true);
  expect(harness.physics.createCharacter.mock.results[0].value.restore).toHaveBeenCalledWith(
    saved.gameplay && (saved.gameplay as any).body,
  );
});

test('membership completion cannot resume presentation during concurrent device recovery', async () => {
  let finishMembership!: () => void, finishRecovery!: () => void;
  harness.renderer.syncWorld.mockReturnValue(
    new Promise<void>((resolve) => {
      finishMembership = resolve;
    }),
  );
  harness.renderer.recover.mockReturnValue(
    new Promise<void>((resolve) => {
      finishRecovery = resolve;
    }),
  );
  await start().start();
  const advance = (time: number) => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(time);
  };
  advance(0);
  view.companion.dispatchEvent(new Event('click'));
  const onLoss = harness.createRenderer.mock.calls[0][2].onDeviceLost;
  onLoss('lost');
  finishMembership();
  await vi.waitFor(() => expect(view.companion.textContent).toBe('Spawn companion'));
  advance(100);
  expect(harness.renderer.render).toHaveBeenCalledTimes(1);
  expect(view.companion.disabled).toBe(true);
  finishRecovery();
  await vi.waitFor(() => expect(view.companion.disabled).toBe(false));
  advance(200);
  expect(harness.renderer.render).toHaveBeenCalledTimes(2);
});

test('a remount on the same canvas waits for canceled GPU startup cleanup', async () => {
  let finish!: (renderer: any) => void;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  const previous = harness.renderer;
  previous.destroy.mockImplementation(() => {
    order.push('old released');
  });
  const replacement = { ...previous, destroy: vi.fn() };
  harness.createRenderer.mockReturnValueOnce(gate).mockImplementation(async () => {
    order.push('new created');
    return replacement;
  });
  const first = start();
  const stopped = first.start().catch((error) => String(error));
  await vi.waitFor(() => expect(harness.createRenderer).toHaveBeenCalledTimes(1));
  window.dispatchEvent(new Event('pagehide'));
  const next = start().start();
  await Promise.resolve();
  await Promise.resolve();
  expect(harness.createRenderer).toHaveBeenCalledTimes(1);
  finish(previous);
  expect(await stopped).toContain('disposed during startup');
  await next;
  expect(order).toEqual(['old released', 'new created']);
});

test('a remount also waits for canceled device recovery to release its candidate', async () => {
  const session = start();
  await session.start();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  harness.renderer.recover.mockImplementation(async () => {
    await gate;
    order.push('recovery released');
  });
  const onLoss = harness.createRenderer.mock.calls[0][2].onDeviceLost;
  onLoss('lost');
  session.destroy();
  harness.createRenderer.mockImplementation(async () => {
    order.push('new created');
    return harness.renderer;
  });
  const pending = start().start();
  await Promise.resolve();
  await Promise.resolve();
  expect(harness.createRenderer).toHaveBeenCalledTimes(1);
  finish();
  await pending;
  expect(order).toEqual(['recovery released', 'new created']);
});
