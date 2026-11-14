# Formwren Form Designer

Form Designer is the VS Code editor for Formwren screens. It opens a `*.form.json` file as a visual designer. The text file stays the source of truth: the designer changes the file, and the text editor shows the same changes.

## What it does

- Shows the form on a canvas, drawn by the same runtime that runs the screen. You can select, move, resize, nudge and delete components, and add them from a palette.
- Shows the components as an outline. You can move a component into or out of a container, or reorder it, and rename it.
- Edits properties, bindings and events in an inspector. It also edits the Datasets (columns, types and sample rows) and the columns of a Grid.
- Runs a preview of the form, with the handler beside it and the saved responses in its fixtures file. See below.
- Makes each change one edit to the text file, so VS Code's undo, redo, save and Git all work. Edits made in the text editor reload in the designer without losing your work.

The designer does not create handler files. It does not write the handler (`*.form.ts`) or the generated types.

## Install

You need VS Code 1.146 or later.

From the repository folder:

```powershell
pnpm install
pnpm vscode:package
pnpm vscode:install
```

`pnpm vscode:package` writes `apps/vscode/fw-designer-0.0.1.vsix`. `pnpm vscode:install` runs `code --install-extension` on that file, so the `code` command must be on your PATH. Run the install again after each new package to update the extension.

To install by hand, open the Extensions view, choose "Install from VSIX...", and pick the same file.

## Use

- Right-click a `*.form.json` file and choose "Open with designer". Or choose "Open With..." and pick "Form Designer".
- The text editor stays the default for these files. Use "Open text editor" in the editor title bar to go back to it.
- A file with Git conflict markers, or with invalid JSON, opens read-only. The designer shows why and never writes to it.

## The preview and the handler

For a form `X.form.json`, the preview runs the handler `X.form.ts` in the same folder. It uses `X.fixtures.json`, if it exists, as the saved responses for the services the handler calls.

- The handler is compiled with the project's own esbuild. The extension looks first for esbuild as a dependency of the project, then for the esbuild that comes with the project's Vite. Run `pnpm install` in the project so that one of them exists. If neither is found, the preview says so.
- The preview only strips types. It does not check them. Run `fw check` for that.
- A handler can import relative files and `@fw/core`. Any other import is refused with a message, because the preview cannot load it.
- The preview runs again when a `.ts`, `.tsx`, `.js` or `.json` file in the form's folder changes.
- The fixtures file has the same format as the demo's `EmployeeEdit.fixtures.json`, with responses keyed by service id. A form with no fixtures file still runs. The preview then says that no fixtures were found.
- The preview only reads files. Running it never changes the form, the handler or the fixtures file.

## Workspace trust

- The extension supports untrusted workspaces, so the designer opens in them.
- In an untrusted workspace, the preview does not run the handler. It says why. When you trust the workspace, the preview runs the handler.
- A handler is TypeScript code that runs on your machine. Trust a workspace only when you trust its code.

## Limits

- The designer opens only `*.form.json` files.
- The designer cannot change the merged header cells of a Grid. Edit those in the text.
- There are no multi-select, align, copy or paste commands yet.
- The preview runs with saved responses from the fixtures file. It does not call a server.
- The extension is packaged as a local `.vsix` file. It is not published to the VS Code Marketplace.

## Tests

From the repository folder, `pnpm vscode:test` runs the extension tests. The first run downloads a test copy of VS Code into `.vscode-test` in the repository. It needs internet access, and a VS Code window opens during the run.
