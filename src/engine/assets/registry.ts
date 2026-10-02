import type { Asset } from '../../gltf/types';
import { loadUrl } from '../../gltf/loader';
import { LoadedModel } from '../loaded-model';
import { identifier } from '../serialization/json';

export type AssetResolver = (uri: string, id: string, signal: AbortSignal) => Promise<Asset>;
export interface AssetRegistryOptions {
  resolve?: AssetResolver;
}
export interface AssetLoadOptions {
  signal?: AbortSignal;
}
export interface AssetLease {
  readonly model: LoadedModel;
  release(): void;
}
export class AssetLoadError extends Error {
  constructor(
    readonly assetId: string,
    readonly uri: string | undefined,
    readonly code: 'missing' | 'load' | 'aborted' | 'lifetime',
    cause?: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? code);
    super(`Asset assets[${JSON.stringify(assetId)}]${uri ? ` (${uri})` : ''}: ${detail}`, {
      cause,
    });
    this.name = code === 'aborted' ? 'AbortError' : 'AssetLoadError';
  }
}
interface RecordEntry {
  uri: string;
  model?: LoadedModel;
  pins: number;
  error?: AssetLoadError;
}
interface Subscriber {
  id: string;
  record: RecordEntry;
  succeed(model: LoadedModel): void;
  fail(error: unknown, aborted?: boolean): void;
}
interface Request {
  controller: AbortController;
  subscribers: Set<Subscriber>;
}

/** CPU asset declarations/cache only. Existing instances hold their LoadedModel
 * directly; eviction never closes their data or releases renderer/device leases. */
export class AssetRegistry {
  private records = new Map<string, RecordEntry>();
  private loaded = new WeakMap<Asset, LoadedModel>();
  private ready = new Map<string, LoadedModel>();
  private requests = new Map<string, Request>();
  private disposed = false;
  private resolve: AssetResolver;
  constructor(options: AssetRegistryOptions = {}) {
    this.resolve = options.resolve ?? ((uri, _id, signal) => loadUrl(uri, { signal }));
  }
  private live(): void {
    if (this.disposed) throw new Error('Asset registry is disposed.');
  }
  private entry(id: string): RecordEntry {
    this.live();
    const record = this.records.get(id);
    if (!record)
      throw new AssetLoadError(id, undefined, 'missing', new Error('Model asset is not declared.'));
    return record;
  }
  declare(id: string, uri: string): void {
    this.live();
    identifier(id);
    identifier(uri);
    const existing = this.records.get(id);
    if (existing && existing.uri !== uri)
      throw new AssetLoadError(
        id,
        uri,
        'load',
        new Error(`ID is already bound to ${existing.uri}.`),
      );
    if (!existing) this.records.set(id, { uri, pins: 0 });
  }
  private shared(asset: Asset): LoadedModel {
    let model = this.loaded.get(asset);
    if (!model) {
      model = new LoadedModel(asset);
      this.loaded.set(asset, model);
    }
    return model;
  }
  register(id: string, asset: Asset, uri: string): void {
    this.live();
    if (this.records.has(id)) throw new Error(`Model asset ${id} is already registered.`);
    if (this.requests.has(uri))
      throw new AssetLoadError(id, uri, 'load', new Error('URI has an active load request.'));
    const previous = this.ready.get(uri);
    if (previous && previous.asset !== asset)
      throw new AssetLoadError(
        id,
        uri,
        'load',
        new Error('URI already has a different loaded asset.'),
      );
    this.declare(id, uri);
    const model = this.shared(asset);
    this.records.get(id)!.model = model;
    this.ready.set(uri, model);
  }
  get(id: string): Asset {
    return this.getModel(id).asset;
  }
  getModel(id: string): LoadedModel {
    const record = this.entry(id);
    if (!record.model)
      throw new AssetLoadError(
        id,
        record.uri,
        'missing',
        new Error(`Model asset ${id} is not loaded.`),
      );
    return record.model;
  }
  references(): Record<string, string> {
    this.live();
    return Object.fromEntries([...this.records].map(([id, record]) => [id, record.uri]));
  }
  /** Same-URI callers share one transport/decode. A caller's cancellation removes
   * only its subscription; the underlying request aborts when its last waiter leaves. */
  load(id: string, options: AssetLoadOptions = {}): Promise<LoadedModel> {
    let record: RecordEntry;
    try {
      record = this.entry(id);
    } catch (error) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted)
      return Promise.reject(new AssetLoadError(id, record.uri, 'aborted', options.signal.reason));
    const cached = record.model ?? this.ready.get(record.uri);
    if (cached) {
      record.model = cached;
      record.error = undefined;
      return Promise.resolve(cached);
    }
    record.error = undefined;
    let request = this.requests.get(record.uri);
    if (!request) {
      request = { controller: new AbortController(), subscribers: new Set() };
      const created = request;
      this.requests.set(record.uri, created);
      // Subscribe before starting a resolver, including resolvers that throw synchronously.
      void Promise.resolve()
        .then(() => {
          created.controller.signal.throwIfAborted();
          return this.resolve(record.uri, id, created.controller.signal);
        })
        .then((asset) => {
          if (created.controller.signal.aborted || !created.subscribers.size) return;
          const model = this.shared(asset);
          this.ready.set(record.uri, model);
          for (const subscriber of [...created.subscribers]) subscriber.succeed(model);
        })
        .catch((error) => {
          for (const subscriber of [...created.subscribers])
            subscriber.fail(error, created.controller.signal.aborted);
        })
        .finally(() => {
          if (this.requests.get(record.uri) === created) this.requests.delete(record.uri);
        });
    }
    const pending = request;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abort);
        pending.subscribers.delete(subscriber);
        if (!pending.subscribers.size) {
          if (this.requests.get(record.uri) === pending) this.requests.delete(record.uri);
          pending.controller.abort();
        }
      };
      const subscriber: Subscriber = {
        id,
        record,
        succeed: (model) => {
          record.model = model;
          record.error = undefined;
          cleanup();
          resolve(model);
        },
        fail: (cause, aborted = false) => {
          const error = new AssetLoadError(id, record.uri, aborted ? 'aborted' : 'load', cause);
          record.error = error;
          cleanup();
          reject(error);
        },
      };
      const abort = () =>
        subscriber.fail(options.signal?.reason ?? new Error('Load cancelled.'), true);
      pending.subscribers.add(subscriber);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  cancel(id: string): void {
    const record = this.entry(id),
      request = this.requests.get(record.uri);
    for (const subscriber of [...(request?.subscribers ?? [])])
      if (subscriber.id === id) subscriber.fail(new Error('Load cancelled.'), true);
  }
  retain(id: string): AssetLease {
    const record = this.entry(id),
      model = this.getModel(id);
    record.pins++;
    let released = false;
    return Object.freeze({
      model,
      release: () => {
        if (!released) {
          released = true;
          record.pins--;
        }
      },
    });
  }
  async acquire(id: string, options: AssetLoadOptions = {}): Promise<AssetLease> {
    await this.load(id, options);
    if (options.signal?.aborted)
      throw new AssetLoadError(id, this.records.get(id)?.uri, 'aborted', options.signal.reason);
    return this.retain(id);
  }
  evict(id: string): boolean {
    const record = this.entry(id);
    if (record.pins)
      throw new AssetLoadError(
        id,
        record.uri,
        'lifetime',
        new Error('CPU model is retained by a lease.'),
      );
    this.cancel(id);
    const removed = !!record.model;
    record.model = undefined;
    record.error = undefined;
    if (![...this.records.values()].some((other) => other.uri === record.uri && other.model))
      this.ready.delete(record.uri);
    return removed;
  }
  forget(id: string): void {
    this.evict(id);
    this.records.delete(id);
  }
  inspect(id: string) {
    const record = this.entry(id);
    const subscribers = [...(this.requests.get(record.uri)?.subscribers ?? [])].filter(
      (subscriber) => subscriber.id === id,
    ).length;
    return Object.freeze({
      id,
      uri: record.uri,
      pins: record.pins,
      subscribers,
      status: record.model
        ? 'ready'
        : subscribers
          ? 'loading'
          : record.error
            ? record.error.code === 'aborted'
              ? 'cancelled'
              : 'failed'
            : 'declared',
      error: record.error?.message,
    });
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of [...this.requests.values()])
      for (const subscriber of [...request.subscribers])
        subscriber.fail(new Error('Asset registry disposed.'), true);
    this.records.clear();
    this.ready.clear();
    this.requests.clear();
    this.loaded = new WeakMap();
  }
}
