import { expect, test, vi } from 'vitest';
import {
  AssetRegistry,
  ModelLibrary,
  ModelInstance,
  loadWorld,
  World,
  ComponentRegistry,
} from '../src/engine';
import { animatedAsset } from './fixtures/animated';
import type { Asset } from '../src/gltf/types';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('same URI requests share transport, resources and clips, with independent model instances', async () => {
  const pending = deferred<Asset>();
  const resolve = vi.fn(() => pending.promise);
  const assets = new AssetRegistry({ resolve });
  assets.declare('hero', 'hero.glb');
  assets.declare('alias', 'hero.glb');
  const first = assets.load('hero'),
    second = assets.load('hero'),
    alias = assets.load('alias');
  expect(assets.inspect('hero')).toMatchObject({ status: 'loading', subscribers: 2 });
  await Promise.resolve();
  expect(resolve).toHaveBeenCalledTimes(1);
  pending.resolve(animatedAsset());
  const [a, b, c] = await Promise.all([first, second, alias]);
  expect(a).toBe(b);
  expect(a).toBe(c);
  const one = new ModelInstance('hero', a),
    two = new ModelInstance('alias', c);
  expect(one.pose.clips).toBe(two.pose.clips);
  expect(one.pose).not.toBe(two.pose);
  expect(one.animation).not.toBe(two.animation);
  expect(assets.get('hero')).toBe(one.asset);
  assets.destroy();
});

test('a cancelled subscriber does not cancel other aliases; the final cancellation aborts transport', async () => {
  const pending = deferred<Asset>();
  let signal!: AbortSignal;
  const assets = new AssetRegistry({
    resolve: (_uri, _id, value) => {
      signal = value;
      return pending.promise;
    },
  });
  assets.declare('hero', 'hero.glb');
  assets.declare('alias', 'hero.glb');
  const controller = new AbortController();
  const cancelled = assets.load('hero', { signal: controller.signal });
  const rejection = expect(cancelled).rejects.toMatchObject({
    name: 'AbortError',
    assetId: 'hero',
  });
  const survivor = assets.load('alias');
  await Promise.resolve();
  controller.abort();
  await rejection;
  expect(signal.aborted).toBe(false);
  pending.resolve(animatedAsset());
  await survivor;
  expect(assets.inspect('hero').status).toBe('cancelled');
  expect(assets.inspect('alias').status).toBe('ready');
  const model = await assets.load('hero');
  expect(model).toBe(assets.getModel('alias'));
  assets.destroy();
  const other = new AssetRegistry({
    resolve: (_uri, _id, value) => {
      signal = value;
      return new Promise(() => {});
    },
  });
  other.declare('hero', 'hero.glb');
  const load = other.load('hero');
  const failed = expect(load).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  other.cancel('hero');
  await failed;
  expect(signal.aborted).toBe(true);
  expect(other.inspect('hero').subscribers).toBe(0);
  other.destroy();
});

test('failures are contextual and retryable, and a late ignored cancellation cannot publish over a retry', async () => {
  const old = deferred<Asset>(),
    fresh = deferred<Asset>();
  const resolve = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => fresh.promise);
  const assets = new AssetRegistry({ resolve });
  assets.declare('hero', 'hero.glb');
  const first = assets.load('hero');
  const rejected = expect(first).rejects.toThrow('assets["hero"]');
  await Promise.resolve();
  assets.cancel('hero');
  await rejected;
  const retry = assets.load('hero');
  await Promise.resolve();
  const expected = animatedAsset();
  fresh.resolve(expected);
  await retry;
  old.resolve(animatedAsset());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(assets.get('hero')).toBe(expected);
  expect(resolve).toHaveBeenCalledTimes(2);
  assets.destroy();
  const broken = new AssetRegistry({
    resolve: vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(expected),
  });
  broken.declare('retry', 'retry.glb');
  await expect(broken.load('retry')).rejects.toMatchObject({
    assetId: 'retry',
    uri: 'retry.glb',
    code: 'load',
  });
  expect(broken.inspect('retry').error).toContain('HTTP 503');
  await broken.load('retry');
  expect(broken.inspect('retry').status).toBe('ready');
  broken.destroy();
});

test('CPU leases protect cache eviction and eviction preserves existing instance resources', async () => {
  const assets = new ModelLibrary();
  const asset = animatedAsset();
  assets.register('hero', asset, 'hero.glb');
  assets.register('alias', asset, 'hero.glb');
  const model = assets.getModel('hero'),
    instance = new ModelInstance('hero', model),
    lease = assets.retain('hero');
  expect(() => assets.evict('hero')).toThrow('retained');
  lease.release();
  lease.release();
  expect(assets.evict('hero')).toBe(true);
  expect(assets.references().hero).toBe('hero.glb');
  expect(() => assets.getModel('hero')).toThrow('not loaded');
  expect(await assets.load('hero')).toBe(model); // Loaded alias still retains the URI cache.
  assets.forget('alias');
  assets.evict('hero');
  expect(instance.resources).toBe(model);
  instance.animation.update(0);
  expect(instance.pose.nodes).toHaveLength(4);
  assets.destroy();
  assets.destroy();
  expect(() => assets.getModel('hero')).toThrow('disposed');
  lease.release();
});

test('scene/schema failures precede loads, shared registries deduplicate scenes and failure publishes no world', async () => {
  const resolve = vi.fn(async () => animatedAsset());
  const assets = new AssetRegistry({ resolve });
  const scene = {
    version: 1,
    assets: { hero: 'hero.glb' },
    entities: [{ id: 'hero', model: { asset: 'hero' } }],
  };
  const [one, two] = await Promise.all([
    loadWorld(scene, undefined, { assets }),
    loadWorld(scene, undefined, { assets }),
  ]);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(one.getEntity('hero').model!.resources).toBe(two.getEntity('hero').model!.resources);
  expect(one.getEntity('hero').model!.pose).not.toBe(two.getEntity('hero').model!.pose);
  const strict = new ComponentRegistry('reject');
  await expect(
    loadWorld({ ...scene, entities: [{ id: 'bad', components: { missing: 3 } }] }, undefined, {
      assets,
      components: strict,
    }),
  ).rejects.toThrow('components["missing"]');
  expect(resolve).toHaveBeenCalledTimes(1);
  await expect(
    loadWorld({ ...scene, entities: [{ id: 'bad', model: { asset: 'absent' } }] }, undefined, {
      assets,
    }),
  ).rejects.toThrow('entities[0].model.asset');
  expect(resolve).toHaveBeenCalledTimes(1);
  const failing = new AssetRegistry({
    resolve: async () => {
      throw new Error('offline');
    },
  });
  await expect(loadWorld(scene, undefined, { assets: failing })).rejects.toThrow('offline');
  expect(failing.inspect('hero').status).toBe('failed');
  assets.destroy();
  failing.destroy();
});

test('registry disposal rejects pending subscribers even if a custom resolver ignores its signal', async () => {
  const pending = deferred<Asset>();
  const assets = new AssetRegistry({ resolve: () => pending.promise });
  assets.declare('hero', 'hero.glb');
  const load = assets.load('hero');
  const rejected = expect(load).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  assets.destroy();
  await rejected;
  pending.resolve(animatedAsset());
  await Promise.resolve();
  await expect(assets.load('hero')).rejects.toThrow('disposed');
  const world = new World();
  expect(() => world.createEntity({ id: 'missing', model: { asset: 'nope' } })).toThrow(
    'entities["missing"].model.asset',
  );
});

test('scene cancellation removes its subscriptions without aborting another client', async () => {
  const pending = deferred<Asset>();
  let transport!: AbortSignal;
  const assets = new AssetRegistry({
    resolve: (_uri, _id, signal) => {
      transport = signal;
      return pending.promise;
    },
  });
  assets.declare('hero', 'hero.glb');
  const peer = assets.load('hero');
  const controller = new AbortController();
  const scene = loadWorld({ version: 1, assets: { hero: 'hero.glb' }, entities: [] }, undefined, {
    assets,
    signal: controller.signal,
  });
  const cancelled = expect(scene).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  controller.abort();
  await cancelled;
  expect(transport.aborted).toBe(false);
  pending.resolve(animatedAsset());
  await peer;
  expect(assets.inspect('hero').status).toBe('ready');
  assets.destroy();
});

test('cancellation between a cached load and acquire does not pin a model; forgotten live references fail saving contextually', async () => {
  const assets = new ModelLibrary();
  assets.register('hero', animatedAsset(), 'hero.glb');
  const controller = new AbortController();
  const lease = assets.acquire('hero', { signal: controller.signal });
  controller.abort();
  await expect(lease).rejects.toMatchObject({ name: 'AbortError' });
  expect(assets.inspect('hero').pins).toBe(0);
  const world = new World(assets);
  world.createEntity({ id: 'player', model: { asset: 'hero' } });
  assets.forget('hero');
  world.update(0);
  expect(() => world.toDocument()).toThrow('entities["player"].model.asset');
  assets.destroy();
});
