# Formwren

## What it is

Formwren is a platform for data-heavy business screens. A screen is a `*.form.json` file with a TypeScript file for its handlers. It runs in the browser with editable tables of rows, and it saves all changes in one database transaction on a small Node server with SQLite. A visual designer edits the screens as text in VS Code.

## What works

The demo app in `apps/demo` covers four journeys:

- **D1, search and list.** Enter conditions and press Search. The Grid fills with employees. Click a header to sort, drag a column edge to resize, and read the footer totals.
- **D2, master and detail.** Choose a department and its employees load. Add, edit and delete departments and employees. One Save sends the changes of both lists in one transaction. An error marks the cell that caused it, and the data reloads after a successful save.
- **D3, lookup popup.** Type a full employee number, or part of a name that matches one employee, and the code and name fill in. A search that matches several employees, or the button, opens a popup to choose one. The popup returns the code and the name.
- **D4, a new screen in the designer.** The designer adds and moves components, and edits properties, bindings, Datasets and Grid columns. Its preview runs the form's real handler. Each change is a small edit to the text, so Git diffs stay small.

## Quick start

Prerequisites:

- Node 26. This is the version CI uses. The root `package.json` asks for Node 24 or later.
- pnpm 10 through Corepack, which ships with Node. Run `corepack enable` once. The pnpm version comes from the `packageManager` field in `package.json`.
- For the browser tests: Microsoft Edge, or Playwright's Chromium. See [Tests](#tests).

Then, from the repository folder:

```powershell
corepack enable
pnpm install
pnpm demo
```

`pnpm demo` starts the demo server on `http://127.0.0.1:5300` and the dev server on port 5173. Open the address it prints, normally `http://localhost:5173/`. Press Ctrl+C in the terminal to stop both. Both ports must be free.

The demo keeps its data in `apps/demo/.data/demo.db`. Run `pnpm demo:reset` to rebuild that file from the seed data.

To look at the screens without the server, run `pnpm --filter demo dev` and open the address with `?fixtures` added. The screens then get saved responses instead of the server.

Check the project:

```powershell
pnpm check
```

This runs the form checks, the type checks, ESLint and the unit tests. It does not need a browser.

## The designer

1. Build the extension package. This writes `apps/vscode/fw-designer-0.0.1.vsix`.

   ```powershell
   pnpm vscode:package
   ```

2. Install that file into VS Code.

   ```powershell
   pnpm vscode:install
   ```

   This runs the `code` command, so `code` must be on your PATH. You can also install the file from the Extensions view with "Install from VSIX...".

3. Open a form. Right-click a `*.form.json` file and choose "Open with designer", or choose "Open With..." and pick "Form Designer". Use "Open text editor" to go back to the text.

To try the designer in a browser, without VS Code, start its development page:

```powershell
pnpm exec vite --config packages/designer/dev/vite.config.ts
```

Then open `http://localhost:5196/dev/index.html`. This page keeps the forms in memory and writes nothing to disk. `?form=EmployeeList` opens another demo form, and `?readOnly=1` opens the form read-only.

## Repository layout

Packages in `packages/`:

- `core`: Datasets, bindings, the form lifecycle, transactions, and the fixture and HTTP transports. No DOM and no React.
- `format`: the schema, validation and text writer for form files.
- `components`: the React components, the shell (menu, tabs and popups) and the default theme.
- `grid`: the virtualized Grid, built on plain DOM.
- `server`: the transaction server, on Fastify and `node:sqlite`.
- `cli`: the `fw` command, with `check`, `fmt`, `dev` and `build`.
- `designer`: the visual designer and its browser development page.

Apps in `apps/`:

- `demo`: the demo screens, seed data, the demo server and the browser tests.
- `vscode`: the VS Code extension that hosts the designer and runs the form preview.

Docs in `docs/`:

- `REQUIREMENTS.md` lists what the project must do. `FRAMEWORK.md` describes the design. `getting-started.md` walks through a new screen.

## Tests

- `pnpm check`: the form checks, the type checks, ESLint and the unit tests (Vitest). No browser needed.
- `pnpm e2e`: the browser tests for the demo. Playwright starts its own demo server on port 5301, with its own database file, and a dev server on port 5180. Stop anything that uses those ports first.
- `pnpm e2e:designer`: the browser tests for the designer. They use its development page on port 5196.
- `pnpm vscode:test`: the extension tests, run inside a test copy of VS Code. The first run downloads that copy into `.vscode-test` in the repository and needs internet access. A VS Code window opens during the run.

Locally the browser tests use Microsoft Edge. To use Playwright's Chromium instead, install it and set `CI` to `1` for the run:

```powershell
pnpm exec playwright install chromium
$env:CI = "1"
pnpm e2e
```

On macOS or Linux, use `CI=1 pnpm e2e`. Setting `CI` also changes the report format and makes `test.only` fail.

## Status

- A personal project. It is not production-ready.
- There is no login, no user roles and no authorization. The server has an optional authorization hook, and without it every request is allowed.
- The demo server listens on `127.0.0.1` only. It also refuses requests whose Host header is not `127.0.0.1`, `localhost` or `[::1]`.
- `fw dev --host` makes the development server listen on other network interfaces. Do not use it on a network you do not trust.
- SQLite is the only database.
- The UI and the messages are in English only.
- The packages are private and are not published to npm.
- Supported browsers are current Chrome and Edge.

## Licence

Apache License 2.0. See [LICENSE](LICENSE). Third-party packages keep their own licences.

## Independence

Formwren is an independent implementation. It is built from public web standards (HTML and WAI-ARIA) and from its own design documents. It is not affiliated with, and not compatible with, any commercial product.
