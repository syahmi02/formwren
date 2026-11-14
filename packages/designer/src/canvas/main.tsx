import '@fw/components/theme.css';
import { startCanvas } from './canvas.tsx';

// Only useful inside the designer's iframe. Opened alone, it just waits.
startCanvas(window, document.getElementById('root') as HTMLElement);
