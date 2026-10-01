import './app/style.css';
import { Viewer } from './app/viewer';

// Bootstrap is separate from the reusable renderer and CPU scene model.
void new Viewer().start();
