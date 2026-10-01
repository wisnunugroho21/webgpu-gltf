import { describe, expect, it, vi } from 'vitest';
import { ResourceCache, Resources } from '../src/renderer/core/resources';

describe('shared model resource lifetime', () => {
  it('shares loads and retains allocations across overlapping scene replacement', async () => {
    const cache = new ResourceCache<object, object>();
    const asset = {},
      value = {};
    const destroy = vi.fn();
    const load = vi.fn(async (resources: Resources) => {
      resources.own({ destroy } as unknown as GPUBuffer);
      return value;
    });
    const previous = new Resources(),
      candidate = new Resources();
    expect(await cache.acquire(asset, previous, load)).toBe(value);
    expect(await cache.acquire(asset, candidate, load)).toBe(value);
    expect(load).toHaveBeenCalledTimes(1);
    previous.destroy();
    expect(destroy).not.toHaveBeenCalled();
    candidate.destroy();
    candidate.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    const next = new Resources();
    await cache.acquire(asset, next, load);
    expect(load).toHaveBeenCalledTimes(2);
    next.destroy();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('releases failed and abandoned asynchronous loads without leaking or poisoning retries', async () => {
    const cache = new ResourceCache<string, number>();
    const failed = new Resources(),
      abandoned = new Resources();
    const destroy = vi.fn();
    await expect(
      cache.acquire('failed', failed, async (resources) => {
        resources.own({ destroy } as unknown as GPUBuffer);
        throw new Error('decode failed');
      }),
    ).rejects.toThrow('decode failed');
    failed.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    const pending = cache.acquire('abandoned', abandoned, async (resources) => {
      resources.own({ destroy } as unknown as GPUBuffer);
      return 1;
    });
    abandoned.destroy();
    await pending;
    expect(destroy).toHaveBeenCalledTimes(2);
    const retry = new Resources();
    expect(await cache.acquire('failed', retry, async () => 2)).toBe(2);
    retry.destroy();
  });
});
