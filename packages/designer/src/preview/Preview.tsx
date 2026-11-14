import { defaultRegistry, FormView } from '@fw/components';
import { createForm, fixtureTransport, type FixtureResponse, type FormDefinition, type FormInstance, type FormModule } from '@fw/core';
import { useEffect, useState, type ReactElement } from 'react';

export interface PreviewProps {
  /** The form to run. A new one restarts the preview. */
  definition: FormDefinition;
  /** The text of the fixtures file, or null if there is none. A bad file is reported, and the preview runs with no transport. */
  fixturesText: string | null;
  /** The form's script, if the host can load it. Without it the form runs with no handlers. */
  module?: FormModule | null;
}

function readFixtures(text: string | null): { responses: Record<string, FixtureResponse> | null; problem: string | null } {
  if (text === null) return { responses: null, problem: null };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { responses: null, problem: 'The fixtures file must be an object of service id to response.' };
    return { responses: value as Record<string, FixtureResponse>, problem: null };
  } catch (error) {
    return { responses: null, problem: `The fixtures file is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Runs the form in run mode, with the real components, in this page. A fixture transport answers its
 * service calls from the fixtures file. It touches nothing: the form file is only ever read.
 */
export function Preview({ definition, fixturesText, module }: PreviewProps): ReactElement {
  const [state, setState] = useState<{ form: FormInstance; messages: string[] } | null>(null);
  const fixtures = readFixtures(fixturesText);

  useEffect(() => {
    const messages: string[] = [];
    const publish = (form: FormInstance): void => setState({ form, messages: [...messages] });
    let current: FormInstance | null = null;
    let live = true;
    try {
      const form = createForm(definition, {
        mode: 'run',
        ...(module ? { module } : {}),
        ...(fixtures.responses ? { transport: fixtureTransport(fixtures.responses, { delayMs: 120 }) } : {}),
        onError: (error, where) => {
          messages.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
          if (live && current) publish(current);
        },
      });
      current = form;
      publish(form);
      form.init().then(
        () => live && publish(form),
        (error: unknown) => {
          messages.push(`init: ${error instanceof Error ? error.message : String(error)}`);
          if (live) publish(form);
        },
      );
    } catch (error) {
      messages.push(error instanceof Error ? error.message : String(error));
      setState(null);
    }
    return () => {
      live = false;
      void current?.close().catch(() => undefined);
    };
    // The fixtures text, not its parse, decides when to restart.
  }, [definition, fixturesText, module]);

  return (
    <div className="dz-preview" role="region" aria-label="Preview">
      <div className="dz-preview__notes">
        <span>
          Running the form as a user would. {fixtures.responses ? `Service calls are answered from the fixtures file (${Object.keys(fixtures.responses).length} services).` : 'There is no fixtures file, so service calls fail.'}
          {module ? '' : ' The form script is not loaded, so handlers do not run.'}
        </span>
        {fixtures.problem ? (
          <span className="dz-field__error" role="alert">
            {fixtures.problem}
          </span>
        ) : null}
        {state && state.messages.length > 0 ? (
          <ul className="dz-preview__messages" aria-label="Preview messages">
            {state.messages.slice(-5).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="dz-preview__form">{state ? <FormView form={state.form} registry={defaultRegistry} /> : null}</div>
    </div>
  );
}
