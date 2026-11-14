import { AppShell, createShellDialogs, defaultRegistry } from '@fw/components';
import '@fw/components/theme.css';
import { createShell, fixtureTransport, httpTransport, type Transport } from '@fw/core';
import { createRoot } from 'react-dom/client';
import { fixtures } from './fixtures.ts';
import { hashRoutes, menu } from './menu.ts';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');
const root = createRoot(container);

// The demo server is the default. `?fixtures` runs on saved responses instead, for anyone who hasn't started the server.
// The dev server forwards /dsx to the server, so the base URL is empty.
const useFixtures = new URLSearchParams(window.location.search).has('fixtures');
const transport: Transport = useFixtures ? fixtureTransport(fixtures, { delayMs: 200 }) : httpTransport('');

const dialogs = createShellDialogs();
const shell = createShell({ transport, confirm: dialogs.confirm });
root.render(<AppShell shell={shell} menu={menu} registry={defaultRegistry} dialogs={dialogs} />);

// A deep link opens its screen as the first tab. Changing the hash later opens or activates that screen too.
function openFromHash(): void {
  const item = menu.find((candidate) => candidate.key === (hashRoutes[window.location.hash] ?? 'employees'));
  if (!item) return;
  item
    .load()
    .then((entry) => shell.open(item.key, entry, { title: item.title }))
    .catch((error: unknown) => console.error(error));
}
openFromHash();
window.addEventListener('hashchange', openFromHash);
