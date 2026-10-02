import type { AudioBackend, AudioEmitter, AudioListenerPose, AudioPoint } from './audio-scene';
function point(value: AudioPoint): void {
  if (value.length !== 3 || !value.every(Number.isFinite))
    throw new Error('Invalid audio position.');
}
function direction(value: AudioPoint): AudioPoint {
  point(value);
  const length = Math.hypot(...value);
  if (length < 1e-8) throw new Error('Audio orientation must be nonzero.');
  return value.map((v) => v / length) as unknown as AudioPoint;
}
/** Explicit browser backend. Construct/resume from a user gesture; autoplay policies
 * can leave the context suspended. Every source/node/cache has a scene-owned lifetime. */
export class WebAudioBackend implements AudioBackend {
  private context = new AudioContext();
  private clips = new Map<string, AudioBuffer>();
  private emitters = new Set<AudioEmitter>();
  private disposed = false;
  private live(): void {
    if (this.disposed) throw new Error('Audio backend is disposed.');
  }
  async loadClip(id: string, bytes: ArrayBuffer): Promise<void> {
    this.live();
    const buffer = await this.context.decodeAudioData(bytes.slice(0));
    this.live();
    this.clips.set(id, buffer);
  }
  registerPCM(id: string, samples: Float32Array, sampleRate = 48000): void {
    this.live();
    if (
      !id.trim() ||
      !samples.length ||
      !samples.every(Number.isFinite) ||
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 96000
    )
      throw new Error('Invalid PCM audio clip.');
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    this.clips.set(id, buffer);
  }
  createEmitter(clip: string, gain = 1): AudioEmitter {
    this.live();
    const buffer = this.clips.get(clip);
    if (!buffer || !Number.isFinite(gain) || gain < 0 || gain > 4)
      throw new Error('Unknown audio clip or invalid gain.');
    const panner = new PannerNode(this.context, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 1,
      maxDistance: 100,
      rolloffFactor: 1,
    });
    const volume = new GainNode(this.context, { gain });
    panner.connect(volume).connect(this.context.destination);
    const sources = new Set<AudioBufferSourceNode>();
    let disposed = false;
    const live = () => {
      this.live();
      if (disposed) throw new Error('Audio emitter is disposed.');
    };
    const stop = () => {
      for (const source of sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
    };
    const emitter: AudioEmitter = {
      setPosition: (position) => {
        live();
        point(position);
        panner.positionX.value = position[0];
        panner.positionY.value = position[1];
        panner.positionZ.value = position[2];
      },
      play: (loop = false) => {
        live();
        if (this.context.state !== 'running') return;
        if (sources.size >= 16) return;
        const source = new AudioBufferSourceNode(this.context, { buffer, loop });
        sources.add(source);
        source.connect(panner);
        source.onended = () => {
          sources.delete(source);
          source.disconnect();
        };
        source.start();
      },
      stop: () => {
        live();
        stop();
      },
      destroy: () => {
        if (disposed) return;
        disposed = true;
        stop();
        panner.disconnect();
        volume.disconnect();
        this.emitters.delete(emitter);
      },
    };
    this.emitters.add(emitter);
    return emitter;
  }
  setListener(pose: AudioListenerPose): void {
    this.live();
    point(pose.position);
    const forward = direction(pose.forward),
      up = direction(pose.up);
    if (Math.abs(forward.reduce((sum, v, i) => sum + v * up[i], 0)) > 0.999)
      throw new Error('Audio forward/up must not be parallel.');
    const listener = this.context.listener;
    [listener.positionX, listener.positionY, listener.positionZ].forEach((p, i) => {
      p.value = pose.position[i];
    });
    [listener.forwardX, listener.forwardY, listener.forwardZ].forEach((p, i) => {
      p.value = forward[i];
    });
    [listener.upX, listener.upY, listener.upZ].forEach((p, i) => {
      p.value = up[i];
    });
  }
  async resume(): Promise<void> {
    this.live();
    await this.context.resume();
  }
  async suspend(): Promise<void> {
    this.live();
    await this.context.suspend();
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const emitter of this.emitters) emitter.destroy();
    this.clips.clear();
    void this.context.close().catch(() => {});
  }
}
