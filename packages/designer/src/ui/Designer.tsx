import { useSignal } from '@fw/components';
import type { ComponentMeta, FormModule } from '@fw/core';
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { parseFromCanvas, type ThemeMessage } from '../canvas/messages.ts';
import type { ComponentBox, DesignerHost, ToCanvas } from '../contract.ts';
import { commands, componentIds, createDesignerModel, findComponent, type ApplyResult, type Command, type DesignerModel } from '../model/index.ts';
import { Preview } from '../preview/index.ts';
import './designer.css';
import { DatasetEditor } from './DatasetEditor.tsx';
import { Inspector } from './Inspector.tsx';
import * as ops from './ops.ts';
import { Outline, type OutlineActions } from './Outline.tsx';
import { Palette } from './Palette.tsx';
import { Stage, type DropSpec, type StageActions } from './Stage.tsx';
import { Tabs } from './Tabs.tsx';
import { useEditorTheme } from './theme.ts';

export interface DesignerProps {
  host: DesignerHost;
  /** What each component type is, by type, for the inspector and the diagnostics. */
  metas: Readonly<Record<string, ComponentMeta>>;
  /** Where the canvas page is served. */
  canvasUrl?: string;
  /**
   * Loads the form's script for the preview, if the host can. Without it the preview runs the form with
   * no handlers. Optional, and added in stage B.
   */
  loadScript?: () => Promise<FormModule | null | undefined>;
}

type LeftTab = 'components' | 'outline' | 'datasets';
type Mode = 'design' | 'preview';

// Worked out on first use, because a bundle without import.meta.url must not fail just by loading.
const defaultCanvasUrl = (): string => new URL('../canvas/index.html', import.meta.url).href;
const DEFAULT_SIZE = { width: 640, height: 480 };

function targetOrigin(url: string): string {
  try {
    const origin = new URL(url, window.location.href).origin;
    return origin === 'null' ? '*' : origin;
  } catch {
    return '*';
  }
}

/** The designer view. It keeps no form of its own: the model re-reads the host's text after every change. */
export function Designer({ host, metas, canvasUrl: givenCanvasUrl, loadScript }: DesignerProps): ReactElement {
  const canvasUrl = givenCanvasUrl ?? defaultCanvasUrl();
  const [model, setModel] = useState<DesignerModel | null>(null);
  useEffect(() => {
    const created = createDesignerModel(host, { metas });
    setModel(created);
    return () => {
      created.dispose();
      setModel(null);
    };
  }, [host, metas]);
  // The text is the reset key: whatever broke the view, a change to the text gives it another try.
  // A host may be a class instance, so its methods are called on it, never passed around unbound.
  const subscribe = useCallback((listener: () => void) => host.onDidChangeText(listener), [host]);
  const readText = useCallback(() => host.readText(), [host]);
  const text = useSyncExternalStore(subscribe, readText);
  return model ? (
    <DesignerBoundary resetKey={text} host={host}>
      <DesignerView model={model} metas={metas} canvasUrl={canvasUrl} loadScript={loadScript} />
    </DesignerBoundary>
  ) : (
    <div className="dz-root" />
  );
}

/** Shows what went wrong instead of a blank page, and tries again when the text changes. */
class DesignerBoundary extends Component<{ resetKey: string; host: DesignerHost; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('The designer view failed', error, info.componentStack);
  }

  override componentDidUpdate(previous: { resetKey: string }): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { host } = this.props;
    return (
      <div className="dz-root" data-testid="designer-error">
        <div className="dz-banner dz-banner--error" role="alert">
          <span>
            <strong>The designer could not show this form.</strong> {error.message} Change the text and it will try again.
          </span>
          {host.openTextEditor ? (
            <button type="button" className="dz-btn" onClick={() => host.openTextEditor?.()}>
              Open text editor
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}

function DesignerView({ model, metas, canvasUrl, loadScript }: { model: DesignerModel; metas: Readonly<Record<string, ComponentMeta>>; canvasUrl: string; loadScript: DesignerProps['loadScript'] }): ReactElement {
  const { host } = model;
  const theme = useEditorTheme();
  const definition = useSignal(model.definition);
  const readOnlyReason = useSignal(model.readOnlyReason);
  const selection = useSignal(model.selection);
  const diagnostics = useSignal(model.diagnostics);
  const text = useSignal(model.text);
  const editable = readOnlyReason === null;
  const selectedId = selection[0] ?? null;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [boxes, setBoxes] = useState<readonly ComponentBox[]>([]);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // What the canvas says. Only its own window is heard.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source === null || event.source !== iframeRef.current?.contentWindow) return;
      const message = parseFromCanvas(event.data);
      if (!message) return;
      if (message.type === 'ready') setReady(true);
      else if (message.type === 'boxes') {
        setBoxes(message.boxes);
        setCanvasSize({ width: message.formWidth, height: message.formHeight });
      } else setCanvasError(message.message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // What the canvas is told. All of it is data.
  const origin = useMemo(() => targetOrigin(canvasUrl), [canvasUrl]);
  const post = useCallback(
    (message: ToCanvas | ThemeMessage): void => {
      iframeRef.current?.contentWindow?.postMessage(message, origin);
    },
    [origin],
  );
  useEffect(() => {
    if (ready) post({ type: 'theme', theme });
  }, [ready, theme, post]);
  useEffect(() => {
    if (ready && definition) {
      setCanvasError(null);
      post({ type: 'definition', definition });
    }
  }, [ready, definition, post]);
  useEffect(() => {
    if (ready) post({ type: 'reveal', id: selectedId });
  }, [ready, selectedId, post]);

  const report = useCallback((result: ApplyResult): ApplyResult => {
    if (result.status === 'rejected') setNotice(result.message);
    else if (result.status === 'refused') setNotice('The editor did not take that change. The form was read again.');
    else setNotice(null);
    return result;
  }, []);
  const run = useCallback(
    (command: Command): Promise<ApplyResult> =>
      model.apply(command).then(report, (error: unknown) => report({ status: 'rejected', message: error instanceof Error ? error.message : String(error) })),
    [model, report],
  );

  const select = useCallback((id: string | null) => (id === null ? model.clearSelection() : model.select([id])), [model]);

  const actions = useMemo<Omit<StageActions, 'add'>>(
    () => ({
      move: (id, dx, dy) => void run(commands.move(id, dx, dy)),
      resize: (id, handle, dx, dy, box) => void run(commands.resize(id, handle, dx, dy, { size: { width: box.width, height: box.height } })),
      nudge: (dx, dy) => void model.nudge(dx, dy).then(report),
      nudgeResize: (id, dx, dy, box) => void run(commands.resize(id, 'se', dx, dy, { size: { width: box.width, height: box.height } })),
      remove: (id) => void run(commands.delete(id)),
    }),
    [model, run, report],
  );

  const found = definition && selectedId ? findComponent(definition, selectedId) : undefined;
  const allIds = useMemo(() => (definition ? componentIds(definition) : []), [definition]);
  // Looked up again after every text change, since the problems belong to the current text.
  const problems = useMemo(() => (selectedId ? model.diagnosticsOf(selectedId) : []), [model, selectedId, diagnostics, text]);

  const onRename = useCallback(
    (newId: string): void => {
      if (!selectedId || newId === selectedId) return;
      void run(commands.setId(selectedId, newId)).then((result) => {
        if (result.status === 'applied') model.select([newId]);
      });
    },
    [selectedId, run, model],
  );

  const size = canvasSize && canvasSize.width > 0 && canvasSize.height > 0 ? canvasSize : (definition?.size ?? DEFAULT_SIZE);

  // ---- Stage B: palette, outline, Datasets, preview -------------------------------------------
  const [leftTab, setLeftTab] = useState<LeftTab>('components');
  const [mode, setMode] = useState<Mode>('design');
  const [drag, setDrag] = useState<{ type: string } | null>(null);
  const [fixturesText, setFixturesText] = useState<string | null>(null);
  const [script, setScript] = useState<FormModule | null>(null);
  const status = useSignal(model.status);
  const formSize = useMemo(() => (canvasSize && canvasSize.width > 0 && canvasSize.height > 0 ? canvasSize : definition?.size), [canvasSize, definition]);
  const hidden = useMemo(() => new Set(boxes.filter((b) => !b.visible).map((b) => b.id)), [boxes]);

  const addAt = useCallback(
    (spec: DropSpec): void => {
      void model.add(spec.type, spec.parentId, { x: spec.left, y: spec.top }).then((result) => {
        report(result);
        if (result.id) model.select([result.id]);
      });
    },
    [model, report],
  );
  // The keyboard route: into the selected container, or at the top level, below what is already there.
  const addTarget = found && metas[found.component.type]?.container ? found.component.id : null;
  const addFromPalette = useCallback(
    (type: string): void => {
      const parent = addTarget ? boxes.find((b) => b.id === addTarget) : undefined;
      const origin = parent ? (parent.content ?? parent) : { x: 0, y: 0 };
      const below = boxes.filter((b) => b.visible && b.parentId === addTarget).reduce((bottom, b) => Math.max(bottom, b.y + b.height - origin.y), 0);
      addAt({ type, parentId: addTarget, left: 16, top: below > 0 ? Math.ceil((below + 8) / 8) * 8 : 16 });
    },
    [addAt, addTarget, boxes],
  );
  const stageActions = useMemo<StageActions>(() => ({ ...actions, add: addAt }), [actions, addAt]);

  const outlineActions = useMemo<OutlineActions>(
    () => ({
      select: (id) => model.select([id]),
      reparent: (id, parentId, index) => void run(ops.reparent(metas, boxes, formSize, id, parentId, index)),
      reorder: (id, delta) => void run(ops.reorder(id, delta)),
      moveInto: (id) => void run(ops.moveInto(metas, boxes, formSize, id)),
      moveOut: (id) => void run(ops.moveOut(metas, boxes, formSize, id)),
      remove: (id) => void run(commands.delete(id)),
      rename: (id, newId) => {
        if (newId === '') return 'An id is required.';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newId)) return 'Use letters, digits and underscores, and do not start with a digit.';
        if (newId !== id && allIds.includes(newId)) return `Another component already uses the id "${newId}".`;
        if (newId !== id) {
          void run(commands.setId(id, newId)).then((result) => {
            if (result.status === 'applied') model.select([newId]);
          });
        }
        return null;
      },
    }),
    [model, run, metas, boxes, formSize, allIds],
  );

  // The fixtures and the script are read when the preview is open, and again when the text changes.
  useEffect(() => {
    if (mode !== 'preview') return;
    let live = true;
    void (host.readFixtures?.() ?? Promise.resolve(null)).then(
      (value) => live && setFixturesText(value),
      () => live && setFixturesText(null),
    );
    return () => {
      live = false;
    };
  }, [mode, host, text]);
  useEffect(() => {
    if (mode !== 'preview' || !loadScript) return;
    let live = true;
    void loadScript().then(
      (value) => live && setScript(value ?? null),
      () => live && setScript(null),
    );
    return () => {
      live = false;
    };
  }, [mode, loadScript]);

  return (
    <div className="dz-root" data-testid="designer">
      <header className="dz-toolbar">
        <span className="dz-toolbar__file" title={host.fileName}>
          {host.fileName}
        </span>
        {readOnlyReason !== null ? (
          <span className="dz-badge" data-testid="readonly-badge">
            Read-only
          </span>
        ) : null}
        <Tabs<Mode>
          label="View"
          className="dz-tabs--view"
          value={mode}
          onChange={setMode}
          items={[
            { id: 'design', label: 'Design' },
            { id: 'preview', label: 'Preview' },
          ]}
        />
        {mode === 'design' && definition && selectedId === null ? <span className="dz-toolbar__hint">Click a component to select it.</span> : null}
      </header>

      {readOnlyReason !== null ? (
        <div className="dz-banner" role="status" data-testid="readonly-banner">
          <span>
            <strong>This form can't be edited here.</strong> {readOnlyReason}
          </span>
          {host.openTextEditor ? (
            <button type="button" className="dz-btn" onClick={() => host.openTextEditor?.()}>
              Open text editor
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <div className="dz-banner dz-banner--error" role="alert">
          {notice}
        </div>
      ) : null}
      {canvasError ? (
        <div className="dz-banner dz-banner--error" role="alert">
          The canvas reported a problem: {canvasError}
        </div>
      ) : null}

      <div className="dz-main">
        <nav className="dz-left" aria-label="Form parts">
          <Tabs<LeftTab>
            label="Form parts"
            value={leftTab}
            onChange={setLeftTab}
            items={[
              { id: 'components', label: 'Components' },
              { id: 'outline', label: 'Outline' },
              { id: 'datasets', label: 'Datasets' },
            ]}
          />
          <div className="dz-left__panel" role="tabpanel">
            {leftTab === 'components' ? (
              <Palette metas={metas} editable={editable} target={addTarget ?? 'the form'} onAdd={addFromPalette} onDragStart={(type) => setDrag({ type })} />
            ) : leftTab === 'outline' ? (
              <Outline definition={definition} metas={metas} selectedId={selectedId} hidden={hidden} editable={editable} actions={outlineActions} />
            ) : (
              <DatasetEditor definition={definition} editable={editable} metas={metas} run={(command) => void run(command)} />
            )}
          </div>
        </nav>
        <div className="dz-canvasarea" hidden={mode === 'preview'}>
          {definition ? (
            <Stage
              definition={definition}
              boxes={boxes}
              width={size.width}
              height={size.height}
              selectedId={selectedId}
              onSelect={select}
              editable={editable}
              actions={stageActions}
              canvasUrl={canvasUrl}
              iframeRef={iframeRef}
              metas={metas}
              drag={drag}
              onDragEnd={() => setDrag(null)}
            />
          ) : (
            <p className="dz-empty">There is no form to show yet.</p>
          )}
        </div>
        {mode === 'preview' ? (
          <div className="dz-canvasarea dz-previewarea">
            {definition && status.status === 'ok' ? <Preview definition={definition} fixturesText={fixturesText} module={script} /> : <p className="dz-empty">The preview needs a form that can be read. Fix the file first.</p>}
          </div>
        ) : null}
        <Inspector
          component={found?.component ?? null}
          meta={found ? metas[found.component.type] : undefined}
          allIds={allIds}
          diagnostics={problems}
          editable={editable}
          definition={definition}
          bindingChoices={(key) => (selectedId ? model.bindingChoices(selectedId, key) : [])}
          openTextEditor={host.openTextEditor ? () => host.openTextEditor?.() : undefined}
          onCommand={(command) => void run(command)}
          onRename={onRename}
        />
      </div>
    </div>
  );
}
