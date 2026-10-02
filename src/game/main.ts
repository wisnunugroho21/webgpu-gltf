import './style.css';
import { gameElements } from './controls';
import { GameSession } from './session';

// The entry point owns only mounting/HMR. The session reports startup failures and
// releases partial resources before rejecting; keep that rejection handled here.
try {
  const session = new GameSession(gameElements(document));
  if (import.meta.hot) import.meta.hot.dispose(() => session.destroy());
  void session.start().catch(() => {});
} catch (error) {
  const status = document.querySelector('#status');
  if (status) status.textContent = `Unable to start: ${String(error)}`;
}
