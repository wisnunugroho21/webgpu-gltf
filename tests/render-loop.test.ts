import { expect, test, vi } from 'vitest';
import {
  ViewerRenderLoop,
  type FrameScheduler,
} from '../browser-tests/fixtures/viewer/app/render-loop';

function scheduler() {
  let next = 0;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const frames: FrameScheduler = {
    request: (callback) => {
      callbacks.set(++next, callback);
      return next;
    },
    cancel: (handle) => {
      callbacks.delete(handle);
    },
  };
  const tick = (timestamp: number) => {
    const [handle, callback] = [...callbacks][0];
    callbacks.delete(handle);
    callback(timestamp);
  };
  return { frames, callbacks, tick };
}

test('viewer adapter owns one request and forwards the caller clock exactly', () => {
  const clock = scheduler();
  const render = vi.fn(() => true);
  const loop = new ViewerRenderLoop({ render }, clock.frames);
  expect(clock.callbacks.size).toBe(0);
  loop.start();
  loop.start();
  expect(clock.callbacks.size).toBe(1);
  clock.tick(10);
  clock.tick(26);
  expect(render.mock.calls).toEqual([[10], [26]]);
  expect(clock.callbacks.size).toBe(1);
  loop.destroy();
  expect(clock.callbacks.size).toBe(0);
});

test('cancelled callbacks cannot render or interfere with a restarted adapter', () => {
  const clock = scheduler();
  const render = vi.fn(() => true);
  const loop = new ViewerRenderLoop({ render }, clock.frames);
  loop.start();
  const stale = [...clock.callbacks.values()][0];
  loop.stop();
  loop.stop();
  loop.start();
  stale(10);
  expect(render).not.toHaveBeenCalled();
  expect(clock.callbacks.size).toBe(1);
  clock.tick(20);
  expect(render.mock.calls).toEqual([[20]]);
  loop.destroy();
  loop.start();
  expect(clock.callbacks.size).toBe(0);
});

test('failure, thrown callbacks and stopping during a frame leave no scheduled work', () => {
  for (const mode of ['false', 'throw', 'stop']) {
    const clock = scheduler();
    const loop = new ViewerRenderLoop(
      {
        render: () => {
          if (mode === 'throw') throw new Error('Callback failure');
          if (mode === 'stop') loop.stop();
          return mode !== 'false';
        },
      },
      clock.frames,
    );
    loop.start();
    if (mode === 'throw') expect(() => clock.tick(0)).toThrow('Callback failure');
    else clock.tick(0);
    expect(clock.callbacks.size, mode).toBe(0);
    loop.destroy();
  }
});

test('stop/restart during rendering retains only the new generation', () => {
  const clock = scheduler();
  const render = vi.fn(() => {
    loop.stop();
    loop.start();
    return true;
  });
  const loop = new ViewerRenderLoop({ render }, clock.frames);
  loop.start();
  clock.tick(0);
  expect(render).toHaveBeenCalledTimes(1);
  expect(clock.callbacks.size).toBe(1);
  loop.destroy();
});
