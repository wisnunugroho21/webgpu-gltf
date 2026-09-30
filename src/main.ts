import './style.css';
import { demoAsset } from './demo';
import { loadFiles, loadUrl } from './gltf/loader';
import type { Asset } from './gltf/types';
import { Renderer } from './renderer/renderer';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status');
const controls = [
  ...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button, input'),
];
let renderer: Renderer;
let busy = false;
let failed = false;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
