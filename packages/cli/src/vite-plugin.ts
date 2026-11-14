import { basename, dirname, relative, resolve } from 'node:path';
import type { CheckOptions } from '@fw/format';
import type { Plugin } from 'vite';
import { defaultCheckOptions, describe, inspectFormText } from './diagnostics.ts';
import { findForms } from './files.ts';
import { writeFormTypes } from './gen.ts';
import { readFormFile } from './source.ts';

/**
 * The importable module is a virtual one, not the `.json` file itself, because Vite's own JSON
 * plugin would try to parse whatever this plugin returns for an id that ends in `.json`, so the id gets a `.js` suffix.
 */
const PREFIX = '\0fw-form:';
const SUFFIX = '.js';
const FORM_FILE = /\.form\.json$/;

const withoutQuery = (id: string): string => id.replace(/[?#].*$/, '');
const normalize = (path: string): string => path.replace(/\\/g, '/');

export interface FwFormsOptions {
  /** Checked against each form. Defaults to the built-in components. */
  check?: CheckOptions;
}

/** Imports `X.form.json` as a `FormEntry`. The form's script becomes its own chunk. */
export function fwForms(options: FwFormsOptions = {}): Plugin {
  let root = process.cwd();
  const check = (): CheckOptions => options.check ?? defaultCheckOptions();

  /** Validates a form and regenerates its types. Returns the definition, or throws a message that names the file. */
  function readForm(file: string, warn: (message: string) => void): { definition: { script?: string } } {
    const name = normalize(relative(root, file));
    const source = readFormFile(file);
    if (!source.ok) throw new Error(`${name}:1: ${source.message}`);
    const inspection = inspectFormText(source.text, check(), { file, root });
    if (inspection.status === 'unreadable') {
      throw new Error(`${name}:${inspection.line}: ${inspection.message}`);
    }
    const problems = inspection.diagnostics.map((diagnostic) => ({
      text: `${name}:${diagnostic.line}: ${describe(diagnostic)}`,
      severity: diagnostic.severity,
    }));
    for (const problem of problems) if (problem.severity === 'warning') warn(problem.text);
    const errors = problems.filter((problem) => problem.severity === 'error').map((problem) => problem.text);
    if (inspection.schemaValid) writeFormTypes(file, inspection.definition);
    if (errors.length > 0) {
      throw new Error(`${errors.length === 1 ? 'Form error' : `${errors.length} form errors`}\n${errors.join('\n')}`);
    }
    return { definition: inspection.definition };
  }

  return {
    name: 'fw-forms',
    // Runs before Vite's own resolver and JSON handling.
    enforce: 'pre',

    configResolved(config) {
      root = config.root;
    },

    buildStart() {
      for (const file of findForms(root)) {
        const source = readFormFile(file);
        if (!source.ok) continue; // The import reports it.
        const inspection = inspectFormText(source.text, {});
        if (inspection.status === 'read' && inspection.schemaValid) writeFormTypes(file, inspection.definition);
      }
    },

    async resolveId(source, importer, resolveOptions) {
      // ?raw and ?url ask for the file itself, which Vite handles.
      if (/[?&](?:raw|url)(?:&|=|$)/.test(source)) return null;
      const clean = withoutQuery(source);
      if (!FORM_FILE.test(clean)) return null;
      const resolved = await this.resolve(clean, importer, { ...resolveOptions, skipSelf: true });
      if (!resolved || !FORM_FILE.test(resolved.id)) return null;
      return PREFIX + withoutQuery(resolved.id) + SUFFIX;
    },

    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = id.slice(PREFIX.length, -SUFFIX.length);
      this.addWatchFile(file);
      let form;
      try {
        form = readForm(file, (message) => this.warn(message));
      } catch (failure) {
        this.error((failure as Error).message);
      }
      const script = form.definition.script;
      const load =
        script === undefined
          ? '() => Promise.resolve({ setup: () => ({}) })'
          : `() => import(${JSON.stringify(normalize(resolve(dirname(file), script)))}).then((m) => { if (m.default === undefined) throw new Error(${JSON.stringify(`The script of ${basename(file)} has no default export. Use: export default defineForm(...)`)}); return m.default; })`;
      return `const definition = ${JSON.stringify(form.definition)};\nexport default { definition, load: ${load} };\n`;
    },

    // Covers created and deleted forms as well as changed ones.
    hotUpdate({ type, file }) {
      if (!FORM_FILE.test(file) || this.environment.name !== 'client') return;
      const module = this.environment.moduleGraph.getModuleById(PREFIX + normalize(file) + SUFFIX);
      if (module) this.environment.moduleGraph.invalidateModule(module);
      const logger = this.environment.logger;
      if (type !== 'delete') {
        try {
          readForm(file, (message) => logger.warn(message));
        } catch (failure) {
          logger.error((failure as Error).message);
        }
      }
      // A form change reloads the page for now. A failed load shows Vite's overlay on that reload.
      this.environment.hot.send({ type: 'full-reload' });
      return [];
    },
  };
}
