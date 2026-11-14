import { memo, useCallback, useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import type { Registry } from '../contract.ts';
import { FormView, useSignal } from '../host/index.tsx';
import type { ShellDialogs } from './dialogs.ts';
import { plainErrorMessage, useDelayedFlag, useSignalSelect } from './hooks.ts';
import type { MenuItem, ReadyShellPopup, Shell, ShellPopup, ShellTab } from './types.ts';

export interface AppShellProps {
  shell: Shell;
  menu: readonly MenuItem[];
  registry: Registry;
  /** The bridge that serves the shell's `confirm` option. Without it, no confirm dialog is drawn. */
  dialogs?: ShellDialogs;
  /** How long calls must be in flight before the loading indicator shows. */
  busyDelayMs?: number;
}

const BUSY_DELAY_MS = 300;

/**
 * Draws a shell model. Each part reads only its own signal, so a change to a tab's data never reaches this
 * component, and opening a popup never re-renders the tab pages.
 */
export function AppShell({ shell, menu, registry, dialogs, busyDelayMs = BUSY_DELAY_MS }: AppShellProps): ReactElement {
  return (
    <div className="fw-shell">
      <Menu shell={shell} menu={menu} />
      <div className="fw-shell__main">
        <TabStrip shell={shell} />
        <TabPages shell={shell} registry={registry} />
      </div>
      <PopupLayer shell={shell} registry={registry} />
      {dialogs && <ConfirmDialog dialogs={dialogs} />}
      <ErrorDialog shell={shell} />
      <LoadingIndicator shell={shell} delayMs={busyDelayMs} />
      <UnloadGuard shell={shell} />
    </div>
  );
}

function Menu({ shell, menu }: { shell: Shell; menu: readonly MenuItem[] }): ReactElement {
  return (
    <nav className="fw-shell__menu" aria-label="Menu">
      <ul className="fw-shell__menu-list">
        {menu.map((item) => (
          <li key={item.key}>
            <MenuButton shell={shell} item={item} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

const MenuButton = memo(function MenuButton({ shell, item }: { shell: Shell; item: MenuItem }): ReactElement {
  const isActive = useSignalSelect(shell.activeTab, useCallback((tab: ShellTab | undefined) => tab?.key === item.key, [item.key]));
  return (
    <button
      type="button"
      className="fw-shell__menu-item"
      aria-current={isActive ? 'page' : undefined}
      onClick={() => openItem(shell, item)}
    >
      {item.title}
    </button>
  );
});

/** An open item is only activated, so its form file isn't loaded again. The shell reports a refusal itself. */
function openItem(shell: Shell, item: MenuItem): void {
  const open = shell.tabs.peek().find((tab) => tab.key === item.key);
  if (open) {
    shell.activate(open.id);
    return;
  }
  item
    .load()
    .then((entry) => shell.open(item.key, entry, { title: item.title }))
    .catch((error: unknown) => reportLoadFailure(shell, item, error));
}

function reportLoadFailure(shell: Shell, item: MenuItem, error: unknown): void {
  const where = `open ${item.key}`;
  if (typeof shell.reportError === 'function') shell.reportError(error, where);
  else console.error(`The form for "${item.title}" could not be loaded`, error);
}

const tabId = (id: string): string => `fw-shell-tab-${id}`;
const panelId = (id: string): string => `fw-shell-panel-${id}`;

function TabStrip({ shell }: { shell: Shell }): ReactElement {
  const tabs = useSignal(shell.tabs);
  const activeId = useSignal(shell.activeId);
  const listRef = useRef<HTMLDivElement>(null);
  // With no active tab the first one takes the tab stop, so the strip can still be reached.
  const stop = activeId ?? tabs[0]?.id ?? null;

  const move = (from: ShellTab, to: ShellTab | undefined): void => {
    if (!to || to === from) return;
    shell.activate(to.id);
    // Tabs are focusable by id, and the new one is already in the DOM.
    listRef.current?.querySelector<HTMLElement>(`[id="${tabId(to.id)}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = tabs.find((tab) => tabId(tab.id) === (event.target as HTMLElement).id);
    if (!current) return;
    const at = tabs.indexOf(current);
    const last = tabs.length - 1;
    switch (event.key) {
      case 'ArrowRight':
        move(current, tabs[at === last ? 0 : at + 1]);
        break;
      case 'ArrowLeft':
        move(current, tabs[at === 0 ? last : at - 1]);
        break;
      case 'Home':
        move(current, tabs[0]);
        break;
      case 'End':
        move(current, tabs[last]);
        break;
      case 'Delete':
        void closeAndRefocus(shell, current, tabs, listRef.current);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div ref={listRef} className="fw-shell__tabs" role="tablist" aria-label="Open screens" aria-orientation="horizontal" onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        // The wrapper has no role, so the tab keeps its own, and the close button sits beside it.
        <div key={tab.id} role="presentation" className="fw-shell__tab-item" data-active={tab.id === activeId || undefined}>
          <button
            type="button"
            role="tab"
            id={tabId(tab.id)}
            className="fw-shell__tab"
            aria-selected={tab.id === activeId}
            aria-controls={panelId(tab.id)}
            tabIndex={tab.id === stop ? 0 : -1}
            onClick={() => shell.activate(tab.id)}
          >
            {tab.title}
          </button>
          <button
            type="button"
            className="fw-shell__tab-close"
            aria-label={`Close ${tab.title}`}
            tabIndex={-1}
            onClick={() => {
              void closeAndRefocus(shell, tab, tabs, listRef.current);
            }}
          >
            <span aria-hidden="true">{'×'}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** Closing a tab drops its button, so focus goes to a neighbour or it would fall to the page. */
async function closeAndRefocus(shell: Shell, tab: ShellTab, tabs: readonly ShellTab[], list: HTMLElement | null): Promise<void> {
  const closed = await shell.close(tab.id);
  if (!closed || !list) return;
  const at = tabs.indexOf(tab);
  const next = tabs[at + 1] ?? tabs[at - 1];
  if (next) list.querySelector<HTMLElement>(`[id="${tabId(next.id)}"]`)?.focus();
}

function TabPages({ shell, registry }: { shell: Shell; registry: Registry }): ReactElement {
  const tabs = useSignal(shell.tabs);
  return (
    <div className="fw-shell__pages">
      {tabs.map((tab) => (
        <TabPage key={tab.id} shell={shell} tab={tab} registry={registry} />
      ))}
    </div>
  );
}

/** Stays mounted when inactive and is only hidden, so the form keeps its state. */
const TabPage = memo(function TabPage({ shell, tab, registry }: { shell: Shell; tab: ShellTab; registry: Registry }): ReactElement {
  const active = useSignalSelect(shell.activeId, useCallback((id: string | null) => id === tab.id, [tab.id]));
  return (
    <div role="tabpanel" id={panelId(tab.id)} aria-labelledby={tabId(tab.id)} className="fw-shell__page" hidden={!active}>
      <FormView form={tab.form} registry={registry} />
    </div>
  );
});

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function canFocus(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && !element.closest('[hidden], [inert]') && !element.hasAttribute('disabled');
}

/** The first thing to focus under the popups that are left: the top popup's form, else the active tab's page. */
function fallbackTarget(): HTMLElement | undefined {
  const popupBodies = document.querySelectorAll('.fw-shell__popup-body');
  const root = popupBodies.length > 0 ? popupBodies[popupBodies.length - 1] : document.querySelector('.fw-shell__page:not([hidden])');
  return Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).find((el) => el.isConnected);
}

/**
 * Swapping a loading popup for its form replaces one overlay with another, and React Aria then forgets the
 * element that had focus before the popup. So the shell remembers it when the popup is first listed, and puts
 * focus back when the popup goes. Focus never ends on the page body.
 */
function PopupLayer({ shell, registry }: { shell: Shell; registry: Registry }): ReactElement | null {
  const popups = useSignal(shell.popups);
  const openers = useRef(new Map<string, HTMLElement>());
  const previous = useRef<readonly string[]>([]);
  // Popups cancelled while the shell could not stop them yet, because their script was still loading.
  const cancelled = useRef(new Set<string>());
  // Read while rendering, before the new overlay takes focus. Keyed by id, so a repeated render changes nothing.
  for (const popup of popups) {
    if (!openers.current.has(popup.id) && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      openers.current.set(popup.id, document.activeElement);
    }
  }
  useEffect(() => {
    const ids = popups.map((popup) => popup.id);
    const gone = previous.current.filter((id) => !ids.includes(id));
    previous.current = ids;
    if (gone.length === 0) return undefined;
    const targets = gone.map((id) => openers.current.get(id));
    for (const id of gone) openers.current.delete(id);
    for (const id of gone) cancelled.current.delete(id);
    const restore = (): void => {
      // Only when focus has been lost. If React Aria already put it back somewhere sensible, leave it.
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const target = targets.find(canFocus) ?? fallbackTarget();
      target?.focus();
    };
    restore();
    let second = 0;
    const first = requestAnimationFrame(() => {
      restore();
      second = requestAnimationFrame(restore);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [popups]);
  if (popups.length === 0) return null;
  return (
    <>
      {popups.map((popup) => (
        <PopupDialog key={popup.id} shell={shell} popup={popup} registry={registry} cancelled={cancelled.current} />
      ))}
    </>
  );
}

/**
 * One modal per popup. React Aria's overlay stack lets only the top one react to Esc and keeps focus inside it,
 * hides the ones under it from assistive technology, and returns focus to the opener when it unmounts.
 */
const PopupDialog = memo(function PopupDialog({
  shell,
  popup,
  registry,
  cancelled,
}: {
  shell: Shell;
  popup: ShellPopup;
  registry: Registry;
  cancelled: Set<string>;
}): ReactElement {
  if (popup.loading === true) return <LoadingPopup shell={shell} popup={popup} cancelled={cancelled} />;
  return <ReadyPopup shell={shell} popup={popup} registry={registry} cancelled={cancelled} />;
});

/** A popup whose form is still opening. It blocks everything behind it, and Esc cancels it. */
function LoadingPopup({ shell, popup, cancelled }: { shell: Shell; popup: ShellPopup; cancelled: Set<string> }): ReactElement {
  return (
    <ModalOverlay
      className="fw-shell__overlay fw-shell__overlay--loading"
      isOpen
      onOpenChange={(open) => {
        if (open) return;
        // The shell can't close a popup whose script is still loading and says no. Remember the wish, and honour it
        // the moment the form is there, so Esc is never silently ignored.
        void shell.closePopup(popup.id).then((closed) => {
          if (!closed) cancelled.add(popup.id);
        });
      }}
    >
      <Modal className="fw-shell__modal">
        <Dialog className="fw-shell__alert fw-shell__loading" aria-label={`Loading ${popup.title}`}>
          <span className="fw-shell__spinner" aria-hidden="true" />
          <span role="status">Loading...</span>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ReadyPopup({ shell, popup, registry, cancelled }: { shell: Shell; popup: ReadyShellPopup; registry: Registry; cancelled: Set<string> }): ReactElement {
  useEffect(() => {
    if (!cancelled.delete(popup.id)) return;
    void shell.closePopup(popup.id);
  }, [cancelled, shell, popup.id]);
  const definition = useSignal(popup.form.definition);
  const size = definition.size;
  return (
    <ModalOverlay
      className="fw-shell__overlay"
      isOpen
      onOpenChange={(open) => {
        if (!open) void shell.closePopup(popup.id);
      }}
    >
      <Modal className="fw-shell__modal">
        <Dialog className="fw-shell__popup" aria-label={popup.title}>
          <div className="fw-shell__popup-bar">
            <Heading slot="title" className="fw-shell__popup-title">
              {popup.title}
            </Heading>
            <Button className="fw-shell__popup-close" aria-label={`Close ${popup.title}`} onPress={() => void shell.closePopup(popup.id)}>
              <span aria-hidden="true">{'×'}</span>
            </Button>
          </div>
          <div className="fw-shell__popup-body" style={size ? { width: size.width, height: size.height } : undefined}>
            <FormView form={popup.form} registry={registry} />
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ConfirmDialog({ dialogs }: { dialogs: ShellDialogs }): ReactElement | null {
  const request = useSignal(dialogs.request);
  if (!request) return null;
  return (
    <ModalOverlay
      className="fw-shell__overlay"
      isOpen
      onOpenChange={(open) => {
        if (!open) request.answer(false);
      }}
    >
      <Modal className="fw-shell__modal">
        <Dialog role="alertdialog" className="fw-shell__alert" aria-label="Confirm">
          <p className="fw-shell__alert-message">{request.message}</p>
          <div className="fw-shell__alert-actions">
            <Button className="fw-shell__button" onPress={() => request.answer(true)}>
              Yes
            </Button>
            {/* The safe answer has focus, so Enter alone never discards work. */}
            <Button className="fw-shell__button" autoFocus onPress={() => request.answer(false)}>
              No
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ErrorDialog({ shell }: { shell: Shell }): ReactElement | null {
  const error = useSignal(shell.lastError);
  if (!error) return null;
  return (
    <ModalOverlay
      className="fw-shell__overlay"
      isOpen
      onOpenChange={(open) => {
        if (!open) shell.dismissError();
      }}
    >
      <Modal className="fw-shell__modal">
        <Dialog role="alertdialog" className="fw-shell__alert" aria-labelledby="fw-shell-error-title">
          <Heading slot="title" id="fw-shell-error-title" className="fw-shell__alert-title">
            Something went wrong
          </Heading>
          <p className="fw-shell__alert-message">{plainErrorMessage(error.message)}</p>
          <div className="fw-shell__alert-actions">
            <Button className="fw-shell__button" autoFocus onPress={() => shell.dismissError()}>
              Dismiss
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The live region is always there, because a region added together with its text is often not announced. */
function LoadingIndicator({ shell, delayMs }: { shell: Shell; delayMs: number }): ReactElement {
  const inFlight = useSignalSelect(shell.busy, useCallback((count: number) => count > 0, []));
  const shown = useDelayedFlag(inFlight, delayMs);
  return (
    <div className="fw-shell__busy" role="status" aria-live="polite" data-shown={shown || undefined}>
      {shown && (
        <>
          <span className="fw-shell__spinner" aria-hidden="true" />
          <span>Loading</span>
        </>
      )}
    </div>
  );
}

/**
 * The shell has no signal for unsaved changes, so the listener stays, and it only asks the browser to warn
 * when `hasUnsavedChanges()` is true at that moment.
 */
function UnloadGuard({ shell }: { shell: Shell }): null {
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent): void => {
      // A draft in a text input or a Grid editor reaches the Dataset on blur, and reloading doesn't blur.
      // Blur commits it synchronously, so the check below sees it.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body) focused.blur();
      if (!shell.hasUnsavedChanges()) return;
      event.preventDefault();
      // Older browsers need a value here to show the warning.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [shell]);
  return null;
}
