// The runtime canvas the designer embeds. Its page is webview/canvas.html, which has a strict policy
// of its own, so the styles of the page live in a file (canvas-page.css) and not inline.
import '../../../packages/designer/src/canvas/main.tsx';
import './canvas-page.css';
