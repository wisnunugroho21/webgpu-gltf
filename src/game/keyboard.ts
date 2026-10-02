import { ActionInput } from '../engine/input/actions';

const bindings: Record<string, string> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  Space: 'jump',
};
/** DOM lifetime stays in the application. Ignore controls while focus is in a
 * form, clear held keys on focus loss, and retain aliases independently. */
export function bindKeyboard(input: ActionInput): () => void {
  const controller = new AbortController(),
    options = { signal: controller.signal };
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches('input, textarea, select, button')
      )
        return;
      const action = bindings[event.code];
      if (action) {
        event.preventDefault();
        input.set(action, true, event.code);
      }
    },
    options,
  );
  window.addEventListener(
    'keyup',
    (event) => {
      const action = bindings[event.code];
      if (action) input.set(action, false, event.code);
    },
    options,
  );
  window.addEventListener('blur', () => input.clear(), options);
  return () => {
    controller.abort();
    input.clear();
  };
}
