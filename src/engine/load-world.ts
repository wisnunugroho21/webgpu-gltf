import { AssetRegistry, type AssetResolver } from './assets/registry';
import type { ComponentRegistry } from './components/registry';
import { parseSceneDocument } from './scene-document';
import { ModelLibrary } from './model';
import { World } from './world';

export interface LoadWorldOptions {
  /** Shared CPU registry; configure its resolver at construction. */
  assets?: AssetRegistry;
  components?: ComponentRegistry;
  signal?: AbortSignal;
}

/** Validate the complete scene/components before loading or publishing a world.
 * Failure cancels only this scene's subscribers; other registry users keep loading. */
export async function loadWorld(
  value: unknown,
  resolve?: AssetResolver,
  options: LoadWorldOptions = {},
): Promise<World> {
  const document = parseSceneDocument(value, options.components);
  if (options.assets && resolve)
    throw new Error('Configure the shared registry resolver instead of passing a scene resolver.');
  options.signal?.throwIfAborted();
  const library = options.assets ?? new ModelLibrary({ resolve });
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (const [id, uri] of Object.entries(document.assets)) library.declare(id, uri);
    await Promise.all(
      Object.keys(document.assets).map((id) => library.load(id, { signal: controller.signal })),
    );
    controller.signal.throwIfAborted();
    return World.fromDocument(document, library, options.components);
  } catch (error) {
    controller.abort(error);
    if (!options.assets) library.destroy();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}
