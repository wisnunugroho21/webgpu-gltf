# Spatial audio

`AudioScene` is a CPU association service and `AudioBackend` is its backend contract. It attaches emitters to entity identities and updates their positions after world hierarchy evaluation. An optional entity listener supplies position and forward/up basis; applications may instead set a camera listener directly on the backend. Removed entities stop/release their emitters even if a new entity reuses the same ID. The scene releases its emitters; the caller separately owns/destroys the backend.

```ts
import { AudioScene } from './src/engine';
import { WebAudioBackend } from './src/engine/audio/web-audio';

// Call in a click/key gesture: browser autoplay rules may initially suspend audio.
const backend = new WebAudioBackend();
await backend.resume();
await backend.loadClip('step', await (await fetch('/audio/step.wav')).arrayBuffer());
const audio = new AudioScene(backend);
const footstep = audio.attach(world.getEntity('player'), 'step', 0.8);
audio.setListener(world.getEntity('listener'));
// After world.update(...), before rendering:
audio.update(world);
footstep.play(); // Or play(true) for a looping source.
// On pause: stop short effects to avoid resuming old footfalls later.
audio.stop();
await backend.suspend();
// On unload:
audio.destroy();
backend.destroy();
```

The Web Audio backend caches decoded clips, supports mono PCM registration, and owns a gain/panner chain per emitter. It uses HRTF with inverse-distance attenuation in world-space units. Source nodes are one-use objects, disconnected when ended/stopped. An emitter allows at most sixteen concurrent sources; attempts while suspended are ignored. Orientations must be finite and nonzero with nonparallel forward/up. Buffer caches and nodes are released with the backend; resume/suspend/loading remain explicit async application actions. These rules follow the [Web Audio lifecycle and spatialization specification](https://webaudio.github.io/web-audio-api/).

`/` provides **Enable audio**, an original generated footfall and a follow-camera listener. Fixed-step footfall counts are consumed once during presentation with bounded sound playback; enabling sound/loading a save does not replay history. Pause, suspension and recovery stop short effects and suspend the context. No audio asset or remote download is required. Backend failures report locally rather than stopping simulation. Audio playback time is not persisted in game saves. Sound component schemas, authored audio asset registries, music scheduling, occlusion/reverb and automatic looping-emitter serialization are subsequent features.
