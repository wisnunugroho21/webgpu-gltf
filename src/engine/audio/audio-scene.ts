import type { Entity } from '../entity';
import type { World } from '../world';
export type AudioPoint = readonly [number, number, number];
export interface AudioListenerPose {
  position: AudioPoint;
  forward: AudioPoint;
  up: AudioPoint;
}
export interface AudioEmitter {
  setPosition(position: AudioPoint): void;
  play(loop?: boolean): void;
  stop(): void;
  destroy(): void;
}
export interface AudioBackend {
  createEmitter(clip: string, gain?: number): AudioEmitter;
  setListener(pose: AudioListenerPose): void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  destroy(): void;
}
/** Content-loading extension for the original synthesized footstep clip. Backend
 * construction/resume remains application-owned and user-gesture driven. */
export interface PcmAudioBackend extends AudioBackend {
  registerPCM(id: string, samples: Float32Array, sampleRate?: number): void;
}
/** CPU association layer. The backend owns voices; entities supply spatial roots.
 * Update after world evaluation, so hierarchy motion reaches audio in the same frame.
 * Removal stops voices even when a replacement reuses the old gameplay ID. */
export class AudioScene {
  private emitters = new Map<AudioEmitter, Entity>();
  private listener?: Entity;
  constructor(private backend: AudioBackend) {}
  attach(entity: Entity, clip: string, gain = 1): AudioEmitter {
    const emitter = this.backend.createEmitter(clip, gain);
    this.emitters.set(emitter, entity);
    return emitter;
  }
  detach(emitter: AudioEmitter): void {
    if (this.emitters.delete(emitter)) emitter.destroy();
  }
  setListener(entity?: Entity): void {
    this.listener = entity;
  }
  stop(): void {
    for (const emitter of this.emitters.keys()) emitter.stop();
  }
  update(world: World): void {
    const live = new Set(world.entities);
    for (const [emitter, entity] of this.emitters) {
      if (!live.has(entity)) {
        this.detach(emitter);
        continue;
      }
      const m = entity.worldMatrix;
      emitter.setPosition([m[12], m[13], m[14]]);
    }
    if (this.listener && live.has(this.listener)) {
      const m = this.listener.worldMatrix;
      this.backend.setListener({
        position: [m[12], m[13], m[14]],
        forward: [-m[8], -m[9], -m[10]],
        up: [m[4], m[5], m[6]],
      });
    } else this.listener = undefined;
  }
  destroy(): void {
    for (const emitter of this.emitters.keys()) emitter.destroy();
    this.emitters.clear();
    this.listener = undefined;
  }
}
