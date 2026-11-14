import type { AnyDataset, ComponentDefinition, ComponentHandle, ComponentModel, FormInstance } from '@fw/core';
import {
  Component,
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Registry } from '../contract.ts';

export interface FormViewProps {
  form: FormInstance;
  registry: Registry;
}

/** The part of a signal that React needs. */
export interface Subscribable<T> {
  peek(): T;
  subscribe(fn: (value: T) => void): () => void;
}

/**
 * Reads a signal for rendering. A signal calls back once on subscribe, and that call is skipped
 * because `useSyncExternalStore` has the value already. Never reads `.value` during render.
 */
export function useSignal<T>(source: Subscribable<T>): T {
  const subscribe = useCallback(
    (notify: () => void) => {
      let first = true;
      return source.subscribe(() => {
        if (first) first = false;
        else notify();
      });
    },
    [source],
  );
  return useSyncExternalStore(subscribe, () => source.peek());
}

interface HostEnv {
  registry: Registry;
  design: boolean;
  onError: (error: unknown, where: string) => void;
  getDataset: (id: string) => AnyDataset | undefined;
}

const HostEnvContext = createContext<HostEnv | null>(null);
const ModelContext = createContext<ComponentModel | null>(null);

function useHostEnv(): HostEnv {
  const env = useContext(HostEnvContext);
  if (!env) throw new Error('Components must be rendered inside a FormView');
  return env;
}

/**
 * Looks a Dataset up by id, for a component that works on Datasets other than its own binding, such as a
 * Grid whose dropdown options come from one. Call it in an effect and never hold the result in React state.
 */
export function useDatasetLookup(): (id: string) => AnyDataset | undefined {
  return useHostEnv().getDataset;
}

/** Reports an error through the form, for a component with callbacks of its own outside React. */
export function useErrorReporter(): (error: unknown, where: string) => void {
  return useHostEnv().onError;
}

/** The model of the component being rendered. For containers that need their children's state. */
export function useComponentModel(): ComponentModel {
  const model = useContext(ModelContext);
  if (!model) throw new Error('useComponentModel must be used inside a component rendered by the host');
  return model;
}

/** Subscribes to the resolved props of several models at once, for example a container's pages. */
export function useModelsProps(
  models: readonly ComponentModel[],
  select: (props: Readonly<Record<string, unknown>>, model: ComponentModel) => string,
): string[] {
  const subscribe = useCallback(
    (notify: () => void) => {
      const stops = models.map((model) => {
        let first = true;
        return model.props.subscribe(() => {
          if (first) first = false;
          else notify();
        });
      });
      return () => stops.forEach((stop) => stop());
    },
    [models],
  );
  // Strings compare by value, so the snapshot is stable until something actually changes.
  const joined = useSyncExternalStore(subscribe, () => models.map((m) => select(m.props.peek(), m)).join('\u0000'));
  return useMemo(() => (models.length === 0 ? [] : joined.split('\u0000')), [joined, models.length]);
}

export function FormView({ form, registry }: FormViewProps): ReactElement {
  const definition = useSignal(form.definition);
  const components = useSignal(form.components);
  const design = form.mode === 'design';
  const env = useMemo<HostEnv>(() => ({ registry, design, onError: (error, where) => form.reportError(error, where), getDataset: (id) => form.getDataset(id) }), [registry, design, form]);
  const size = definition.size;
  // Positioned so that top-level components are placed relative to the form.
  const style: CSSProperties = { position: 'relative' };
  if (size) {
    style.width = size.width;
    style.height = size.height;
  }
  return (
    <HostEnvContext.Provider value={env}>
      <div className="fw-form" data-mode={form.mode} style={style}>
        {components.map((model) => (
          <ComponentHost key={model.id} model={model} />
        ))}
      </div>
    </HostEnvContext.Provider>
  );
}

function layoutStyle(definition: ComponentDefinition): CSSProperties {
  const style: CSSProperties = { position: 'absolute' };
  for (const edge of ['left', 'top', 'right', 'bottom', 'width', 'height'] as const) {
    const value = definition.layout[edge];
    if (typeof value === 'number') style[edge] = value;
  }
  if (typeof definition.z === 'number') style.zIndex = definition.z;
  return style;
}

// The component draws in a portal, so its own box must neither take space nor catch clicks.
const PORTAL_HOST_STYLE: CSSProperties = { position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' };

/** One per component. It re-renders only for definition changes (design mode). Props live in the body. */
export const ComponentHost = memo(function ComponentHost({ model }: { model: ComponentModel }): ReactElement {
  const env = useHostEnv();
  const definition = useSignal(model.definition);
  const registration = Object.hasOwn(env.registry, definition.type) ? env.registry[definition.type] : undefined;
  const portal = registration?.portal === true && !env.design;
  return (
    <div
      className="fw-host"
      data-id={model.id}
      data-type={definition.type}
      style={portal ? PORTAL_HOST_STYLE : layoutStyle(definition)}
      inert={env.design || undefined}
    >
      <HostBoundary id={model.id} onError={env.onError}>
        {/* A type change remounts the component, and nothing else does. */}
        <ComponentBody key={definition.type} model={model} type={definition.type} />
      </HostBoundary>
    </div>
  );
});

const ComponentBody = memo(function ComponentBody({ model, type }: { model: ComponentModel; type: string }): ReactElement {
  const { registry, design } = useHostEnv();
  const props = useSignal(model.props);
  const childModels = useSignal(model.children);
  const write = useCallback((prop: string, value: unknown, rowId?: number) => model.write(prop, value, rowId), [model]);
  const accepts = useCallback((prop: string, value: unknown) => model.accepts(prop, value), [model]);
  const fire = useCallback((event: string, detail?: unknown) => model.fire(event, detail), [model]);
  // React 19 calls a callback ref with null on unmount, which is when the handle is dropped.
  const handleRef = useCallback((handle: ComponentHandle | null) => model.setHandle(handle), [model]);

  const registration = Object.hasOwn(registry, type) ? registry[type] : undefined;
  if (!registration) {
    return (
      <div className="fw-host__placeholder" role="note">
        {type}
      </div>
    );
  }
  const Render = registration.render;
  const children: ReactNode = registration.meta.container
    ? childModels.map((child) => <ComponentHost key={child.id} model={child} />)
    : undefined;
  return (
    <ModelContext.Provider value={model}>
      <Render id={model.id} props={props as never} write={write} accepts={accepts} fire={fire} handleRef={handleRef} design={design}>
        {children}
      </Render>
    </ModelContext.Provider>
  );
});

interface BoundaryProps {
  id: string;
  onError: (error: unknown, where: string) => void;
  children: ReactNode;
}

class HostBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError(error, `component ${this.props.id}`);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fw-host__error" role="alert">
        {error.message}
      </div>
    );
  }
}
