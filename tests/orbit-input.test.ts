import { expect, test } from 'vitest';
import { OrbitCamera } from '../src/engine';
import { OrbitInput } from '../src/app/orbit-input';

test('viewer input changes orbit state and removes every listener on teardown', () => {
  // EventTarget lets this lifecycle regression run without a browser or GPU.
  class Canvas extends EventTarget {
    setPointerCapture(_id: number): void {}
  }
  const canvas = new Canvas();
  const camera = new OrbitCamera();
  const input = new OrbitInput(canvas as unknown as HTMLCanvasElement, camera);
  const dispatch = (type: string, fields: Record<string, number>) => {
    const event = Object.assign(new Event(type, { cancelable: true }), fields);
    canvas.dispatchEvent(event);
    return event;
  };
  const initial = camera.yaw;
  dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  dispatch('pointermove', { pointerId: 1, clientX: 20, clientY: 10 });
  expect(camera.yaw).toBeCloseTo(initial - 0.06);
  expect(dispatch('wheel', { deltaY: 20 }).defaultPrevented).toBe(true);
  expect(camera.distance).toBeGreaterThan(4);
  input.destroy();
  input.destroy();
  const yaw = camera.yaw,
    distance = camera.distance;
  dispatch('pointermove', { pointerId: 1, clientX: 100, clientY: 10 });
  expect(dispatch('wheel', { deltaY: 200 }).defaultPrevented).toBe(false);
  expect(camera.yaw).toBe(yaw);
  expect(camera.distance).toBe(distance);
});
