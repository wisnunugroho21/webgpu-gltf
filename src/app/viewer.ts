import { Renderer } from '../renderer/renderer';
import { loadFiles, loadUrl } from '../gltf/loader';
import type { Asset } from '../gltf/types';
import { demoAsset } from './demo';
import { element, disableControls, errorMessage } from './dom';
import { AnimationControls } from './controls/animation';
import { bindDisplayControls } from './controls/display';
import { bindEnvironmentControls } from './controls/environment';
import { ViewerRenderLoop } from './render-loop';
import { OrbitInput } from './orbit-input';
import { renderViewerFrame } from './frame';

/** Application state and serialized loading. Widgets don't own renderer lifetime. */
export class Viewer {
  private renderer?: Renderer;
  private renderLoop?: ViewerRenderLoop;
  private orbitInput?: OrbitInput;
  private animationControls?: AnimationControls;
  private busy = false;
  private failed = false;

  async start(): Promise<void> {
    try {
      const renderer = await Renderer.create(
        element<HTMLCanvasElement>('canvas'),
        (message) => this.fail(message),
        {
          onDeviceLost: (message) => {
            this.renderLoop?.stop();
            this.busy = true;
            disableControls(true);
            element('status').textContent = `${message} Reconnecting…`;
            void renderer
              .recover()
              .then(() => {
                this.busy = false;
                disableControls(this.failed);
                this.animationControls?.update();
                element('status').textContent = 'GPU reconnected';
                if (!this.failed) this.renderLoop?.start();
              })
              .catch((error) => this.fail(errorMessage(error)));
          },
        },
      );
      this.renderer = renderer;
      this.orbitInput = new OrbitInput(element<HTMLCanvasElement>('canvas'), renderer.camera);
      this.renderLoop = new ViewerRenderLoop({
        render: (timestamp) => {
          try {
            return renderViewerFrame(renderer, timestamp);
          } catch (error) {
            this.fail(errorMessage(error));
            return false;
          }
        },
      });
      this.animationControls = new AnimationControls(renderer, () => this.busy || this.failed);
      bindDisplayControls(renderer);
      bindEnvironmentControls(renderer, (source, name) =>
        this.load('environment-name', `Preparing ${name}…`, async () => {
          await renderer.setEnvironmentMap(await source());
          element('environment-name').textContent = name;
        }),
      );
      this.bindModelControls();
      element('reset').addEventListener('click', () => renderer.camera.reset());
      window.addEventListener('pagehide', this.pageHide, { once: true });
      if (!this.failed) this.renderLoop.start();
      await this.show(demoAsset, 'Built-in instancing scene');
    } catch (error) {
      this.fail(errorMessage(error));
      this.destroy();
    }
  }

  private fail(message: string): void {
    this.failed = true;
    this.renderLoop?.stop();
    element('status').textContent = message;
    disableControls(true);
  }

  private pageHide = (): void => this.destroy();

  /** Cancel the owner loop before releasing any resources it could draw from. */
  destroy(): void {
    this.renderLoop?.destroy();
    this.orbitInput?.destroy();
    this.renderer?.destroy();
    window.removeEventListener('pagehide', this.pageHide);
  }

  /** Model and environment loading share a lock and control restoration. */
  private async load(target: string, pending: string, action: () => Promise<void>): Promise<void> {
    if (this.busy || this.failed) return;
    this.busy = true;
    disableControls(true);
    element(target).textContent = pending;
    try {
      await action();
    } catch (error) {
      if (!this.failed) element(target).textContent = errorMessage(error);
    } finally {
      this.busy = false;
      disableControls(this.failed);
      this.animationControls?.update();
    }
  }

  private show(source: () => Promise<Asset> | Asset, name: string): Promise<void> {
    return this.load('status', `Loading ${name}…`, async () => {
      const asset = await source();
      const stats = await this.renderer!.setAsset(asset);
      this.animationControls!.refreshClips();
      if (!this.failed) element('status').textContent = name;
      element('stats').textContent =
        `${stats.pipelines} pipelines · ${stats.draws} draws · ${stats.instances} primitive instances`;
      element('warnings').textContent = asset.warnings.join(' ');
    });
  }

  private bindModelControls(): void {
    element('demo').addEventListener('click', () => {
      void this.show(demoAsset, 'Built-in instancing scene');
    });
    element<HTMLInputElement>('files').addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const files = [...(input.files ?? [])];
      if (files.length)
        void this.show(
          () => loadFiles(files, { textureCompression: this.renderer!.textureCompression }),
          files.find((file) => /\.(gltf|glb)$/i.test(file.name))?.name ?? 'Local model',
        );
      input.value = '';
    });
    element('url-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const url = element<HTMLInputElement>('url').value;
      // Naming is cosmetic. Invalid URLs must reach load()'s recoverable error
      // path instead of throwing synchronously from the event listener.
      let name = 'Remote model';
      try {
        name = new URL(url, location.href).pathname.split('/').pop() || name;
      } catch {}
      void this.show(
        () => loadUrl(url, { textureCompression: this.renderer!.textureCompression }),
        name,
      );
    });
  }
}
