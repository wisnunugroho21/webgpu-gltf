import { expect, test } from 'vitest';
import { EngineRuntime, World, type EngineSystem } from '../src/engine';

test('systems initialize once, execute in phase/order, and dispose in reverse initialization order', () => {
  const events: string[] = [];
  const system = (id: string, phase: EngineSystem['phase'], order = 0): EngineSystem => ({
    id,
    phase,
    order,
    initialize: () => {
      events.push(`init:${id}`);
    },
    destroy: () => {
      events.push(`destroy:${id}`);
    },
    ...(phase === 'presentation'
      ? {
          presentationUpdate: () => {
            events.push(id);
          },
        }
      : {
          fixedUpdate: () => {
            events.push(id);
          },
        }),
  });
  const world = new World();
  const entity = world.createEntity({ id: 'player' });
  const move: EngineSystem = {
    id: 'move',
    phase: 'gameplay',
    order: -1,
    fixedUpdate: ({ world }) => {
      world.getEntity('player').setTransform({ translation: [2, 0, 0] });
    },
  };
  const runtime = new EngineRuntime(
    world,
    {
      gameplay: () => events.push('legacy:gameplay'),
      physics: () => events.push('legacy:physics'),
      preparePresentation: () => events.push('legacy:presentation'),
      present: () => {
        expect(entity.worldMatrix[12]).toBe(runtimeTime ? 2 : 0);
      },
    },
    {
      stepMs: 10,
      systems: [
        system('late', 'gameplay', 2),
        system('physics', 'physics'),
        system('early', 'gameplay'),
        system('visual', 'presentation'),
        move,
      ],
    },
  );
  let runtimeTime = 0;
  runtime.advance(0);
  expect(events.slice(0, 4)).toEqual(['init:early', 'init:late', 'init:physics', 'init:visual']);
  events.length = 0;
  runtimeTime = 10;
  runtime.advance(10);
  expect(events).toEqual([
    'early',
    'late',
    'legacy:gameplay',
    'physics',
    'legacy:physics',
    'visual',
    'legacy:presentation',
  ]);
  runtime.pause();
  events.length = 0;
  runtime.advance(20);
  expect(events).toEqual(['visual', 'legacy:presentation']);
  events.length = 0;
  runtime.destroy();
  runtime.destroy();
  expect(events).toEqual(['destroy:visual', 'destroy:physics', 'destroy:late', 'destroy:early']);
});

test('initialization failure destroys partially initialized systems and never runs simulation', () => {
  const events: string[] = [];
  const runtime = new EngineRuntime(
    new World(),
    {},
    {
      systems: [
        {
          id: 'one',
          phase: 'gameplay',
          initialize: () => {
            events.push('one');
          },
          fixedUpdate: () => {
            events.push('tick');
          },
          destroy: () => {
            events.push('cleanup:one');
          },
        },
        {
          id: 'bad',
          phase: 'gameplay',
          initialize: () => {
            events.push('bad');
            throw new Error('setup failed');
          },
          fixedUpdate: () => {},
          destroy: () => {
            events.push('cleanup:bad');
          },
        },
      ],
    },
  );
  expect(() => runtime.advance(0)).toThrow('System bad initialize failed');
  expect(events).toEqual(['one', 'bad', 'cleanup:bad', 'cleanup:one']);
  expect(() => runtime.advance(1)).toThrow('disposed');
  runtime.destroy();
});

test('cleanup continues after a failure and includes every initialized system exactly once', () => {
  const events: string[] = [];
  const runtime = new EngineRuntime(
    new World(),
    {},
    {
      systems: [
        {
          id: 'one',
          phase: 'gameplay',
          fixedUpdate: () => {},
          destroy: () => {
            events.push('one');
          },
        },
        {
          id: 'two',
          phase: 'physics',
          fixedUpdate: () => {},
          destroy: () => {
            events.push('two');
            throw new Error('cleanup');
          },
        },
      ],
    },
  );
  runtime.advance(0);
  expect(() => runtime.destroy()).toThrow('cleanup failed');
  runtime.destroy();
  expect(events).toEqual(['two', 'one']);
  const unused = new EngineRuntime(
    new World(),
    {},
    {
      systems: [
        {
          id: 'unused',
          phase: 'gameplay',
          fixedUpdate: () => {},
          destroy: () => {
            throw new Error('never started');
          },
        },
      ],
    },
  );
  unused.destroy();
});

test('class receivers and copied schedule metadata survive outside edits; async/reentrant callbacks reject', () => {
  class Counter implements EngineSystem {
    id = 'count';
    phase = 'gameplay' as const;
    order = 0;
    ticks = 0;
    fixedUpdate() {
      this.ticks++;
    }
  }
  const counter = new Counter();
  const runtime = new EngineRuntime(new World(), {}, { stepMs: 10, systems: [counter] });
  runtime.advance(0);
  counter.phase = 'physics' as 'gameplay';
  runtime.advance(10);
  expect(counter.ticks).toBe(1);
  runtime.destroy();
  const asynchronous = new EngineRuntime(
    new World(),
    {},
    { stepMs: 10, systems: [{ id: 'async', phase: 'gameplay', fixedUpdate: async () => {} }] },
  );
  asynchronous.advance(0);
  expect(() => asynchronous.advance(10)).toThrow('System async gameplay failed');
  asynchronous.destroy();
  const recursive = new EngineRuntime(new World(), {
    present: () => {
      recursive.advance(0);
    },
  });
  expect(() => recursive.advance(0)).toThrow('reentrant');
  recursive.destroy();
});

test('invalid schedules fail at construction rather than running unused callbacks', () => {
  const fixed: EngineSystem = { id: 'same', phase: 'gameplay', fixedUpdate: () => {} };
  expect(() => new EngineRuntime(new World(), {}, { systems: [fixed, fixed] })).toThrow(
    'Duplicate system',
  );
  expect(
    () =>
      new EngineRuntime(
        new World(),
        {},
        { systems: [{ id: 'bad', phase: 'presentation', fixedUpdate: () => {} }] },
      ),
  ).toThrow('requires the callback');
  expect(() => new EngineRuntime(new World(), {}, { systems: [{ ...fixed, order: NaN }] })).toThrow(
    'Invalid system schedule',
  );
});

test('disposing during initialization prevents later initializers from acquiring unowned resources', () => {
  const events: string[] = [];
  const runtime = new EngineRuntime(
    new World(),
    {},
    {
      systems: [
        {
          id: 'stop',
          phase: 'gameplay',
          initialize: () => runtime.destroy(),
          fixedUpdate: () => {},
          destroy: () => {
            events.push('cleanup');
          },
        },
        {
          id: 'later',
          phase: 'physics',
          initialize: () => {
            events.push('leaked');
          },
          fixedUpdate: () => {},
        },
      ],
    },
  );
  expect(() => runtime.advance(0)).toThrow('disposed during initialization');
  expect(events).toEqual(['cleanup']);
  runtime.destroy();
});
