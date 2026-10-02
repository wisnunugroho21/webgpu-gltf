import type { JsonValue } from '../engine/serialization/json';
import { ComponentRegistry } from '../engine/components/registry';
export interface BoxColliderComponent {
  version: 1;
  halfExtents: [number, number, number];
}
export interface ActorComponent {
  version: 1;
  role: 'player' | 'companion';
}

/** Game-owned schema, shared by fresh levels, restored saves and editor writes.
 * The scene and model formats retain their own independent version contracts. */
export function gameComponents(): ComponentRegistry {
  const components = new ComponentRegistry();
  components.registerVersioned<ActorComponent>('game.actor', {
    version: 1,
    parse(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !['version', 'role'].includes(key)) ||
        (value.role !== 'player' && value.role !== 'companion')
      )
        throw new Error('Actor role must be player or companion.');
      return { version: 1, role: value.role };
    },
  });
  components.registerVersioned<BoxColliderComponent>('game.colliderBox', {
    version: 1,
    parse: boxColliderComponent,
  });
  return components;
}

/** Shared by registry validation and backend installation, including a World that
 * preserves unknown JSON because the game schema was not registered at creation. */
export function boxColliderComponent(value: JsonValue): BoxColliderComponent {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !['version', 'halfExtents'].includes(key)) ||
    !Array.isArray(value.halfExtents) ||
    value.halfExtents.length !== 3 ||
    !value.halfExtents.every(
      (extent) => typeof extent === 'number' && Number.isFinite(extent) && extent > 0,
    )
  )
    throw new Error('Box version 1 requires three positive finite halfExtents.');
  return { version: 1, halfExtents: [...value.halfExtents] as [number, number, number] };
}
