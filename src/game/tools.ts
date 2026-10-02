import type { World } from '../engine/world';
import type { EngineRuntime } from '../engine/runtime/runtime';
import type { Renderer } from '../renderer/renderer';
import type { FollowCamera } from '../engine/camera/follow-camera';
import type { CharacterSimulation } from './simulation';
import type { JsonValue } from '../engine/serialization/json';
import { captureSaveState } from '../engine/serialization/save-state';
import { inspectWorld } from '../engine/inspection';
import { AudioScene, type AudioEmitter, type PcmAudioBackend } from '../engine/audio/audio-scene';

/** Optional application tooling, kept out of simulation and renderer ownership.
 * Storage and audio failures report locally; they do not destroy a playable world. */
export class GameTools {
  private events = new AbortController();
  private audio?: PcmAudioBackend;
  private audioScene?: AudioScene;
  private footstep?: AudioEmitter;
  private lastFootfalls: number;
  private lastInspection = 0;
  private paused = false;
  private disposed = false;
  constructor(
    private world: World,
    runtime: EngineRuntime,
    private renderer: Renderer,
    private simulation: CharacterSimulation,
    private busy: () => boolean,
    private createAudio: () => PcmAudioBackend,
  ) {
    this.lastFootfalls = simulation.footfalls;
    const options = { signal: this.events.signal };
    document.querySelector('#save')!.addEventListener(
      'click',
      () => {
        if (this.busy()) return;
        try {
          const saved = captureSaveState(world, runtime, {
            body: simulation.body.checkpoint() as unknown as JsonValue,
            footfalls: simulation.footfalls,
            rootMotion: simulation.rootMotionEnabled,
            locomotion: simulation.locomotion.state,
          });
          localStorage.setItem('engine-game-save', JSON.stringify(saved));
          this.status('Saved');
        } catch (error) {
          this.status(`Save failed: ${String(error)}`);
        }
      },
      options,
    );
    document.querySelector('#load')!.addEventListener(
      'click',
      () => {
        if (this.busy()) return;
        try {
          const saved = localStorage.getItem('engine-game-save');
          if (!saved) {
            this.status('No save yet');
            return;
          }
          sessionStorage.setItem('engine-game-pending', saved);
          location.reload();
        } catch (error) {
          this.status(`Load failed: ${String(error)}`);
        }
      },
      options,
    );
    document.querySelector('#audio')!.addEventListener(
      'click',
      () => {
        void this.enableAudio().catch((error) => this.status(`Audio failed: ${String(error)}`));
      },
      options,
    );
  }
  private status(message: string): void {
    if (!this.disposed) document.querySelector('#save-status')!.textContent = message;
  }
  private async enableAudio(): Promise<void> {
    if (this.audio || this.disposed || this.busy()) return;
    const audio = (this.audio = this.createAudio());
    try {
      // Original synthesized footfall; production games can load authored clips.
      const samples = new Float32Array(4800);
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.sin(i * 0.045) * Math.exp(-i / 550) * 0.2;
      audio.registerPCM('step', samples);
      this.audioScene = new AudioScene(audio);
      this.footstep = this.audioScene.attach(this.world.getEntity('player'), 'step');
      this.lastFootfalls = this.simulation.footfalls;
      await audio.resume();
      if (this.disposed) return;
      if (this.paused) await audio.suspend();
      if (this.disposed) return;
      document.querySelector('#audio')!.textContent = 'Audio enabled';
    } catch (error) {
      this.releaseAudio(audio);
      throw error;
    }
  }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.audio) return;
    if (paused) this.audioScene?.stop();
    void (paused ? this.audio.suspend() : this.audio.resume()).catch((error) =>
      this.status(`Audio failed: ${String(error)}`),
    );
  }
  update(camera: FollowCamera): void {
    this.audioScene?.update(this.world);
    this.audio?.setListener({
      position: [camera.eye[0], camera.eye[1], camera.eye[2]],
      forward: [
        camera.target[0] - camera.eye[0],
        camera.target[1] - camera.eye[1],
        camera.target[2] - camera.eye[2],
      ],
      up: [0, 1, 0],
    });
    // Event counts are consumed once. Enabling audio or reloading never replays history.
    if (!this.paused)
      for (let i = 0; i < Math.min(4, this.simulation.footfalls - this.lastFootfalls); i++)
        this.footstep?.play();
    this.lastFootfalls = this.simulation.footfalls;
    if (
      performance.now() - this.lastInspection > 250 &&
      (document.querySelector('#inspector') as HTMLDetailsElement).open
    ) {
      document.querySelector('#inspection')!.textContent = JSON.stringify(
        { world: inspectWorld(this.world), gpu: this.renderer.diagnostics },
        null,
        2,
      );
      this.lastInspection = performance.now();
    }
  }
  private releaseAudio(audio = this.audio): void {
    if (!audio || this.audio !== audio) return;
    const scene = this.audioScene;
    // Clear ownership before release; pending resume/suspend failures cannot
    // destroy an already released backend or a later replacement.
    this.audio = undefined;
    this.audioScene = undefined;
    this.footstep = undefined;
    try {
      scene?.destroy();
    } finally {
      audio.destroy();
    }
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.events.abort();
    } finally {
      this.releaseAudio();
    }
  }
}
