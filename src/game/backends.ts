import type { AssetRegistryOptions } from '../engine/assets/registry';
import type { CheckpointPhysicsAdapter } from '../engine/physics/contracts';
import type { PcmAudioBackend } from '../engine/audio/audio-scene';
import { RapierPhysics } from '../engine/physics/rapier';
import { WebAudioBackend } from '../engine/audio/web-audio';

/** Extension points required by this game's actual content: static boxes, saved
 * kinematic character state, and a mono PCM footstep. Factories transfer ownership
 * to the session/tools; returned backends must support idempotent destroy(). */
export interface GameBackends {
  createPhysics(): Promise<CheckpointPhysicsAdapter>;
  /** Called only from the audio-enable gesture, never during session startup. */
  createAudio(): PcmAudioBackend;
  assets?: AssetRegistryOptions;
}
export const browserGameBackends: GameBackends = {
  createPhysics: () => RapierPhysics.create(),
  createAudio: () => new WebAudioBackend(),
};
