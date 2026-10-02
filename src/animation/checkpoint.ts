import type { Pose } from '../scene/pose';
import type { AnimationLayer, LocalPose } from './blending';
import type { AnimationEvent } from './motion';

export interface RootMotionSettings {
  readonly node: number;
  readonly mode: 'in-place' | 'extract';
}
/** Durable controller state, including interrupted-fade snapshots. GPU resources,
 * wall timestamps and callbacks never belong in a save file. */
export interface AnimationCheckpoint {
  version: 1;
  layers: AnimationLayer[];
  overlays: AnimationLayer[];
  playing: boolean;
  clock: 'presentation' | 'external';
  elapsed: number;
  rootMotion?: RootMotionSettings;
  displacement: number[];
  events: AnimationEvent[];
  fade?: { duration: number; elapsed: number; source: AnimationLayer[]; snapshot?: LocalPose[] };
}

/** Validate a detached copy before the controller mutates live playback. Keeping
 * persistence checks here separates save-file shape from playback policy. */
export function validateAnimationCheckpoint(
  checkpoint: AnimationCheckpoint,
  pose: Pose,
): AnimationCheckpoint {
  const state: AnimationCheckpoint = structuredClone(checkpoint);
  if (
    !state ||
    state.version !== 1 ||
    Object.keys(state).some(
      (key) =>
        ![
          'version',
          'layers',
          'overlays',
          'playing',
          'clock',
          'elapsed',
          'rootMotion',
          'displacement',
          'events',
          'fade',
        ].includes(key),
    ) ||
    typeof state.playing !== 'boolean' ||
    !['presentation', 'external'].includes(state.clock) ||
    !Number.isFinite(state.elapsed) ||
    state.elapsed < 0 ||
    !Array.isArray(state.displacement) ||
    state.displacement.length !== 3 ||
    !Array.from(state.displacement).every(Number.isFinite)
  )
    throw new Error('Invalid animation checkpoint.');
  const validateLayers = (layers: readonly AnimationLayer[]) => {
    if (!Array.isArray(layers)) throw new Error('Saved animation layers must be arrays.');
    // The mixer also accepts pose snapshots. A durable layer must explicitly
    // identify its clip before delegating playback validation to the mixer.
    for (const layer of layers)
      if (
        !layer ||
        typeof layer !== 'object' ||
        !Number.isInteger(layer.clip) ||
        !Number.isFinite(layer.time) ||
        (layer.mask !== undefined &&
          (!Array.isArray(layer.mask) ||
            Array.from(layer.mask).some(
              (node) => typeof node !== 'number' || !Number.isInteger(node) || !pose.nodes[node],
            )))
      )
        throw new Error('Invalid saved animation layer.');
    pose.validateBlend(layers);
    for (const layer of layers)
      if (
        layer.time < 0 ||
        layer.time > (pose.clips[layer.clip]?.duration ?? 0) ||
        Object.keys(layer).some(
          (key) =>
            !['clip', 'time', 'weight', 'mask', 'additive', 'referenceTime', 'speed'].includes(key),
        ) ||
        (layer.additive !== undefined && typeof layer.additive !== 'boolean')
      )
        throw new Error('Invalid saved animation layer.');
  };
  validateLayers(state.layers);
  validateLayers(state.overlays);
  if (state.fade !== undefined) {
    const fade = state.fade;
    if (
      !fade ||
      typeof fade !== 'object' ||
      Object.keys(fade).some((key) => !['duration', 'elapsed', 'source', 'snapshot'].includes(key))
    )
      throw new Error('Invalid saved transition.');
    if (
      !(
        Number.isFinite(fade.duration) &&
        fade.duration > 0 &&
        Number.isFinite(fade.elapsed) &&
        fade.elapsed >= 0 &&
        fade.elapsed < fade.duration
      ) ||
      state.layers.length !== 1
    )
      throw new Error('Invalid saved transition.');
    validateLayers(fade.source);
    if (
      fade.snapshot !== undefined &&
      (!Array.isArray(fade.snapshot) ||
        fade.snapshot.length !== pose.nodes.length ||
        Array.from(fade.snapshot).some((node, i) =>
          (['translation', 'rotation', 'scale', 'weights'] as const).some(
            (key) =>
              !node ||
              !Array.isArray(node[key]) ||
              node[key].length !== pose.nodes[i][key].length ||
              !Array.from(node[key]).every(
                (value) => Number.isFinite(value) && Number.isFinite(Math.fround(value)),
              ) ||
              (key === 'rotation' && Math.hypot(...node[key]) < 1e-8),
          ),
        ))
    )
      throw new Error('Invalid saved pose snapshot.');
  }
  if (
    !Array.isArray(state.events) ||
    Array.from(state.events).some(
      (event) =>
        !event ||
        typeof event !== 'object' ||
        !Number.isFinite(event.time) ||
        !Number.isFinite(event.weight) ||
        event.weight < 0 ||
        event.time < 0 ||
        !Number.isInteger(event.clip) ||
        !pose.clips[event.clip] ||
        event.time > pose.clips[event.clip].duration ||
        !Number.isFinite(event.elapsedSeconds) ||
        event.elapsedSeconds < 0 ||
        typeof event.name !== 'string',
    )
  )
    throw new Error('Invalid saved animation events.');
  if (
    state.rootMotion !== undefined &&
    (!state.rootMotion ||
      typeof state.rootMotion !== 'object' ||
      !Number.isInteger(state.rootMotion.node) ||
      !pose.nodes[state.rootMotion.node] ||
      !['in-place', 'extract'].includes(state.rootMotion.mode) ||
      Object.keys(state.rootMotion).some((key) => !['node', 'mode'].includes(key)))
  )
    throw new Error('Invalid saved root motion.');
  return state;
}
