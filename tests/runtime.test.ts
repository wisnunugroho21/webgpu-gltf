import { expect, test } from 'vitest';
import { EngineRuntime, World, ModelLibrary, FollowCamera, OrbitCamera } from '../src/engine';
import { animatedAsset } from './fixtures/animated';
import { validateCameraView } from '../src/engine/camera/view';
import { vec3 } from 'gl-matrix';

function scene() {
  const models = new ModelLibrary();
  models.register('hero', animatedAsset(), 'fixture:hero');
  const world = new World(models);
  const entity = world.createEntity({ id: 'hero', model: { asset: 'hero' } });
  return { world, entity };
}

test('headless runtime orders input, fixed gameplay/physics, presentation, animation and publication', () => {
  const { world, entity } = scene();
  const phases: string[] = [];
  const runtime = new EngineRuntime(
    world,
    {
      captureInput: () => phases.push('input'),
      gameplay: () => {
        phases.push('gameplay');
        entity.setTransform({ translation: [3, 0, 0] });
      },
      physics: () => {
        phases.push('physics');
        entity.setTransformOwner('physics');
        entity.setTransform({ translation: [5, 0, 0] }, 'physics');
        entity.setTransformOwner('gameplay');
      },
      preparePresentation: () => phases.push('presentation'),
      present: () => {
        phases.push('publish');
        expect(entity.worldMatrix[12]).toBe(5);
        expect(entity.model!.pose.nodes[0].world[12]).toBe(15);
      },
    },
    { stepMs: 10 },
  );
  // Initialization publishes prepared roots without a fixed simulation tick.
  entity.setTransform({ translation: [5, 0, 0] });
  runtime.advance(0);
  phases.length = 0;
  const frame = runtime.advance(25);
  expect(phases).toEqual([
    'input',
    'gameplay',
    'physics',
    'gameplay',
    'physics',
    'presentation',
    'publish',
  ]);
  expect(frame).toMatchObject({
    steps: 2,
    simulationTimeMs: 20,
    presentationTimeMs: 25,
    alpha: 0.5,
  });
  expect(entity.model!.animation.state.time).toBeCloseTo(0.025);
});

test('catch-up is bounded and discarded wall time cannot fast-forward visual clips', () => {
  const { world, entity } = scene();
  const runtime = new EngineRuntime(world, {}, { stepMs: 10, maxSteps: 3, maxFrameMs: 100 });
  runtime.advance(0);
  const frame = runtime.advance(1005);
  expect(frame).toMatchObject({
    steps: 3,
    simulationTimeMs: 30,
    presentationTimeMs: 30,
    droppedMs: 975,
  });
  expect(entity.model!.animation.state.time).toBeCloseTo(0.03);
});

test('pause/resume excludes suspended time, retains fractional time and is idempotent', () => {
  const { world, entity } = scene();
  const runtime = new EngineRuntime(world, {}, { stepMs: 10 });
  runtime.advance(0);
  runtime.advance(15);
  runtime.pause();
  runtime.pause();
  expect(runtime.advance(5000)).toMatchObject({ paused: true, steps: 0, presentationTimeMs: 15 });
  expect(entity.model!.animation.state.time).toBeCloseTo(0.015);
  runtime.resume();
  runtime.resume();
  expect(runtime.advance(6000).presentationTimeMs).toBe(15);
  runtime.resume();
  expect(runtime.advance(6010).presentationTimeMs).toBe(25);
});

test('CPU evaluation retains revisions across held poses, skipped rendering and overrides', () => {
  const { world, entity } = scene();
  world.profiling = true;
  world.update(0);
  world.update(1000);
  const revision = entity.model!.pose.revision;
  world.update(1000);
  expect(entity.model!.pose.revision).toBe(revision);
  entity.setTransform({ translation: [12, 0, 0] });
  world.update(1000);
  expect(entity.model!.pose.revision).toBeGreaterThan(revision);
  expect(entity.model!.pose.nodes[0].world[12]).toBe(22);
  const times = world.cpuTimings!;
  times.evaluationMs = -1;
  expect(world.cpuTimings!.evaluationMs).toBeGreaterThanOrEqual(0);
});

test('runtime rejects invalid clocks/options and cannot advance after disposal', () => {
  for (const options of [
    { stepMs: 0 },
    { maxSteps: 0 },
    { maxSteps: 1.5 },
    { maxFrameMs: Infinity },
  ])
    expect(() => new EngineRuntime(new World(), {}, options)).toThrow();
  const runtime = new EngineRuntime(new World());
  expect(() => runtime.advance(NaN)).toThrow();
  runtime.advance(10);
  expect(() => runtime.advance(9)).toThrow();
  runtime.destroy();
  expect(() => runtime.advance(20)).toThrow('disposed');
});

test('orbit and follow cameras are CPU-only, use zero-to-one depth and validate viewport assumptions', () => {
  const orbit = new OrbitCamera();
  const camera = orbit.view(2);
  validateCameraView(camera, 2);
  expect(() => validateCameraView(camera, 1)).toThrow('aspect');
  const follow = new FollowCamera();
  follow.update([2, 0, 0], 0);
  expect([...follow.eye]).toEqual([2, 2, 5]);
  follow.update([4, 0, 0], 0.1);
  expect(follow.eye[0]).toBeGreaterThan(2);
  expect(follow.eye[0]).toBeLessThan(4);
  const view = follow.view(1);
  validateCameraView(view, 1);
  const near = vec3.transformMat4(vec3.create(), [0, 0, -follow.near], view.projection);
  const far = vec3.transformMat4(vec3.create(), [0, 0, -follow.far], view.projection);
  expect(near[2]).toBeCloseTo(0);
  expect(far[2]).toBeCloseTo(1);
  expect(() => follow.update([NaN, 0, 0], 1)).toThrow();
});
