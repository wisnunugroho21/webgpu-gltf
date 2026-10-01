import { expect, test } from 'vitest';
import { prepareGpu } from '../src/renderer/core/preparation';

test('device-scoped preparation serializes owners, validates before commit and recovers after rejection', async () => {
  const events: string[] = [];
  let depth = 0;
  let error: GPUError | null = null;
  const device = {
    pushErrorScope: () => {
      expect(depth++).toBe(0);
      events.push('push');
    },
    popErrorScope: async () => {
      expect(--depth).toBe(0);
      events.push('pop');
      const result = error;
      error = null;
      return result;
    },
  } as unknown as GPUDevice;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = prepareGpu(
    device,
    async () => {
      events.push('model');
      await gate;
      return 1;
    },
    (candidate) => {
      events.push(`commit:${candidate}`);
      return candidate;
    },
  );
  const failure = prepareGpu(
    device,
    async () => {
      events.push('environment');
      error = { message: 'Invalid GPU candidate' } as GPUError;
      return 2;
    },
    () => {
      throw new Error('Invalid candidate was committed');
    },
  );
  const recovered = prepareGpu(
    device,
    async () => {
      events.push('next');
      return 3;
    },
    (candidate) => {
      events.push(`commit:${candidate}`);
      return candidate;
    },
  );
  const rejected = expect(failure).rejects.toThrow('Invalid GPU candidate');
  await Promise.resolve();
  expect(events).toEqual(['push', 'model']);
  release();
  expect(await first).toBe(1);
  await rejected;
  expect(await recovered).toBe(3);
  expect(events).toEqual([
    'push',
    'model',
    'pop',
    'commit:1',
    'push',
    'environment',
    'pop',
    'push',
    'next',
    'pop',
    'commit:3',
  ]);
});

test('CPU failures pop their scope and retain their diagnostic; independent devices do not wait', async () => {
  let popped = 0;
  const device = {
    pushErrorScope: () => {},
    popErrorScope: async () => {
      popped++;
      return { message: 'Secondary GPU error' };
    },
  } as unknown as GPUDevice;
  await expect(
    prepareGpu(
      device,
      async () => {
        throw new Error('Missing image');
      },
      () => {},
    ),
  ).rejects.toThrow('Missing image');
  expect(popped).toBe(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstDevice = {
    pushErrorScope: () => {},
    popErrorScope: async () => null,
  } as unknown as GPUDevice;
  const secondDevice = { ...firstDevice } as GPUDevice;
  const first = prepareGpu(
    firstDevice,
    async () => {
      await gate;
      return 1;
    },
    (value) => value,
  );
  expect(
    await prepareGpu(
      secondDevice,
      async () => 2,
      (value) => value,
    ),
  ).toBe(2);
  release();
  expect(await first).toBe(1);
});
