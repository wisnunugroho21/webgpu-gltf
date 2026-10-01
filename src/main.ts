import './style.css';
import { demoAsset } from './demo';
import { loadFiles, loadUrl } from './gltf/loader';
import type { Asset } from './gltf/types';
import { Renderer } from './renderer/renderer';
import type { ToneMapping } from './renderer/output';
import {
  loadEnvironmentImage,
  studioEnvironment,
  type EnvironmentImage,
} from './renderer/environment-source';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status');
const controls = [
  ...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
    'button, input, select',
  ),
];
let renderer: Renderer;
let busy = false;
let failed = false;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
function updateAnimationControls(): void {
  const state = renderer.animation.state;
  element('animation-controls').hidden = !state.clips.length;
  element<HTMLSelectElement>('animation-clip').value = String(state.clip);
  const timeline = element<HTMLInputElement>('animation-time');
  timeline.max = String(state.duration);
  timeline.value = String(state.time);
  timeline.disabled = failed || busy || state.clip < 0 || state.duration === 0;
  element<HTMLButtonElement>('animation-play').disabled = failed || busy || state.clip < 0;
  element('animation-play').textContent = state.playing ? 'Pause' : 'Play';
  element('animation-clock').textContent =
    `${state.time.toFixed(2)} / ${state.duration.toFixed(2)} s`;
}

async function show(source: () => Promise<Asset> | Asset, name: string): Promise<void> {
  if (busy || failed) return;
  busy = true;
  controls.forEach((control) => {
    control.disabled = true;
  });
  status.textContent = `Loading ${name}…`;
  try {
    const asset = await source();
    const stats = await renderer.setAsset(asset);
    const select = element<HTMLSelectElement>('animation-clip');
    select.replaceChildren(
      new Option('Authored pose', '-1'),
      ...renderer.animation.state.clips.map((name, index) => new Option(name, String(index))),
    );
    if (!failed) status.textContent = name;
    element('stats').textContent =
      `${stats.pipelines} pipelines · ${stats.draws} draws · ${stats.instances} primitive instances`;
    element('warnings').textContent = asset.warnings.join(' ');
  } catch (error) {
    if (!failed) status.textContent = errorMessage(error);
  } finally {
    busy = false;
    controls.forEach((control) => {
      control.disabled = failed;
    });
    updateAnimationControls();
  }
}

async function start(): Promise<void> {
  try {
    renderer = await Renderer.create(element<HTMLCanvasElement>('canvas'), (message) => {
      failed = true;
      status.textContent = message;
      controls.forEach((control) => {
        control.disabled = true;
      });
    });
    renderer.animation.onChange = updateAnimationControls;
    const updateEnvironment = () => {
      const intensity = Number(element<HTMLInputElement>('environment-intensity').value);
      const degrees = Number(element<HTMLInputElement>('environment-rotation').value);
      renderer.setEnvironment({ intensity, rotation: (degrees * Math.PI) / 180 });
      element('environment-intensity-value').textContent = intensity.toFixed(1);
      element('environment-rotation-value').textContent = `${degrees}°`;
    };
    element('environment-intensity').addEventListener('input', updateEnvironment);
    element('environment-rotation').addEventListener('input', updateEnvironment);
    const showEnvironment = async (
      source: () => Promise<EnvironmentImage> | EnvironmentImage,
      name: string,
    ) => {
      if (busy || failed) return;
      busy = true;
      controls.forEach((control) => {
        control.disabled = true;
      });
      element('environment-name').textContent = `Preparing ${name}…`;
      try {
        await renderer.setEnvironmentMap(await source());
        element('environment-name').textContent = name;
      } catch (error) {
        element('environment-name').textContent = errorMessage(error);
      } finally {
        busy = false;
        controls.forEach((control) => {
          control.disabled = failed;
        });
        updateAnimationControls();
      }
    };
    element('environment-studio').addEventListener('click', () => {
      void showEnvironment(studioEnvironment, 'Studio environment');
    });
    element<HTMLInputElement>('environment-file').addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) void showEnvironment(() => loadEnvironmentImage(file), file.name);
      input.value = '';
    });
    const updateOutput = () => {
      const exposureEV = Number(element<HTMLInputElement>('exposure').value);
      renderer.setOutput({
        exposureEV,
        toneMapping: element<HTMLSelectElement>('tone-mapping').value as ToneMapping,
      });
      element('exposure-value').textContent = `${exposureEV.toFixed(1)} EV`;
    };
    element('tone-mapping').addEventListener('change', updateOutput);
    element('exposure').addEventListener('input', updateOutput);
    element('animation-clip').addEventListener('change', () =>
      renderer.animation.select(Number(element<HTMLSelectElement>('animation-clip').value)),
    );
    element('animation-play').addEventListener('click', () =>
      renderer.animation.setPlaying(!renderer.animation.state.playing),
    );
    element('animation-restart').addEventListener('click', () => renderer.animation.seek(0));
    element('animation-time').addEventListener('input', () => {
      const time = Number(element<HTMLInputElement>('animation-time').value);
      renderer.animation.setPlaying(false);
      renderer.animation.seek(time);
    });
    element('demo').addEventListener('click', () => {
      void show(demoAsset, 'Built-in instancing scene');
    });
    element<HTMLInputElement>('files').addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const files = [...(input.files ?? [])];
      if (files.length)
        void show(
          () => loadFiles(files),
          files.find((file) => /\.(gltf|glb)$/i.test(file.name))?.name ?? 'Local model',
        );
      input.value = '';
    });
    element('url-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const url = element<HTMLInputElement>('url').value;
      void show(() => loadUrl(url), new URL(url).pathname.split('/').pop() || 'Remote model');
    });
    element('reset').addEventListener('click', () => renderer.camera.reset());
    window.addEventListener('pagehide', () => renderer.destroy(), { once: true });
    await show(demoAsset, 'Built-in instancing scene');
  } catch (error) {
    status.textContent = errorMessage(error);
    controls.forEach((control) => {
      control.disabled = true;
    });
  }
}
void start();
