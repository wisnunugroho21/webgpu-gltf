// Smoke-test emitted decoder URLs/worker and game WASM startup in a production build.
// The normal browser suite imports TypeScript through Vite and cannot catch these failures.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '5174',
    '--strictPort',
  ],
  { stdio: 'pipe', windowsHide: true },
);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      ready = (await fetch('http://127.0.0.1:5174')).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, 'Production preview did not start. Run the build first.');
  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5174');
  await page.locator('#stats').filter({ hasText: '4 primitive instances' }).waitFor();
  const gltf = JSON.parse(
    await readFile(
      new URL('../tests/fixtures/compression/quad-draco.gltf', import.meta.url),
      'utf8',
    ),
  );
  const load = async (name, json) => {
    await page.route(`**/${name}`, (route) =>
      route.fulfill({ contentType: 'model/gltf+json', body: JSON.stringify(json) }),
    );
    await page.locator('#url').fill(`http://127.0.0.1:5174/${name}`);
    await page.locator('#url-form button').click();
    await page.locator('#status').filter({ hasText: name }).waitFor();
    assert.equal(await page.locator('#warnings').textContent(), '');
  };
  await load('draco.gltf', gltf);
  // Reuse Draco geometry and add Basis KTX2 to exercise both WASM modules in one worker.
  const uv = new Float32Array([0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
  gltf.buffers.push({
    byteLength: uv.byteLength,
    uri: `data:application/octet-stream;base64,${Buffer.from(uv.buffer).toString('base64')}`,
  });
  gltf.bufferViews.push({ buffer: 1, byteLength: uv.byteLength });
  gltf.accessors.push({ bufferView: 1, componentType: 5126, type: 'VEC2', count: 4 });
  gltf.meshes[0].primitives[0].attributes.TEXCOORD_0 = 4;
  const ktx = await readFile(
    new URL('../tests/fixtures/compression/2d_uastc.ktx2', import.meta.url),
  );
  gltf.images = [
    { uri: `data:image/ktx2;base64,${ktx.toString('base64')}`, mimeType: 'image/ktx2' },
  ];
  gltf.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
  gltf.materials[0].pbrMetallicRoughness = { baseColorTexture: { index: 0 } };
  gltf.extensionsRequired.push('KHR_texture_basisu');
  gltf.extensionsUsed.push('KHR_texture_basisu');
  await load('draco-basis.gltf', gltf);
  // The dev suite cannot verify the emitted multipage entry and embedded physics
  // WASM. Exercise the actual production game before ending the preview session.
  await page.goto('http://127.0.0.1:5174/game.html');
  await page.locator('#status').filter({ hasText: 'Grounded' }).waitFor();
  await page.locator('#game').click({ position: { x: 900, y: 600 } });
  await page.keyboard.down('KeyW');
  await page.locator('#status').filter({ hasText: 'Walk' }).waitFor();
  await page.keyboard.up('KeyW');
  await page.locator('#pause').click();
  await page.locator('#status').filter({ hasText: 'Paused' }).waitFor();
  await page.locator('#pause').click();
  await page.locator('#companion').click();
  await page.locator('#companion').filter({ hasText: 'Spawn companion' }).waitFor();
  assert((await fetch('http://127.0.0.1:5174/licenses/rapier-apache-2.0.txt')).ok);
  assert.deepEqual(errors, []);
  console.log('Production Draco/Basis loads and playable game WASM startup passed.');
} finally {
  await browser?.close();
  server.kill();
}
