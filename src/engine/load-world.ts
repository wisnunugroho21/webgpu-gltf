import type { Asset } from '../gltf/types';
import { loadUrl } from '../gltf/loader';
import { parseSceneDocument } from './scene-document';
import { ModelLibrary } from './model';
import { World } from './world';

/** Pass a resolver for relative scene URLs or a device-aware loader. Each asset ID
 * loads once, regardless of the number of entities referencing that model. */
export async function loadWorld(
  value: unknown,
  resolve: (uri: string, id: string) => Promise<Asset> = (uri) => loadUrl(uri),
): Promise<World> {
  const document = parseSceneDocument(value);
  const library = new ModelLibrary();
  const loaded = await Promise.all(
    Object.entries(document.assets).map(async ([id, uri]) => {
      return { id, uri, asset: await resolve(uri, id) };
    }),
  );
  for (const { id, uri, asset } of loaded) library.register(id, asset, uri);
  return World.fromDocument(document, library);
}
