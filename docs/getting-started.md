# Getting started with Formwren

This walks through one new screen, from its form file to the designer. Every command and file here comes from the repository. Run `pnpm install` first (see the README).

The new screen lists the departments. It calls the service `hr.dept.list`, which the demo server and the demo fixtures already have.

## 1. Write the form file

Create `apps/demo/src/forms/DepartmentList.form.json`:

```json
{
  "formatVersion": 1,
  "id": "hr.DepartmentList",
  "title": "Department list",
  "script": "./DepartmentList.form.ts",
  "size": { "width": 640, "height": 420 },
  "events": { "init": "onInit" },
  "datasets": [
    {
      "id": "dsDept",
      "keys": ["code"],
      "columns": [
        { "id": "code", "type": "string", "size": 10 },
        { "id": "name", "type": "string", "size": 50 },
        { "id": "ver", "type": "int", "version": true }
      ],
      "sampleRows": [
        { "code": "ENG", "name": "Engineering" },
        { "code": "SAL", "name": "Sales" }
      ]
    }
  ],
  "components": [
    {
      "id": "reloadButton",
      "type": "Button",
      "layout": { "left": 16, "top": 16, "width": 88, "height": 28 },
      "props": { "text": "Reload", "disabled": "=vars.busy" },
      "events": { "click": "onReload" }
    },
    {
      "id": "countLabel",
      "type": "Label",
      "layout": { "left": 112, "top": 16, "right": 16, "height": 28 },
      "props": { "text": "=vars.message", "live": true }
    },
    {
      "id": "deptGrid",
      "type": "Grid",
      "layout": { "left": 16, "top": 56, "right": 16, "bottom": 16 },
      "props": {
        "columns": [
          { "id": "c1", "width": 120 },
          { "id": "c2", "width": 300 }
        ],
        "headerRows": [
          { "cells": [{ "text": "Code" }, { "text": "Name" }] }
        ],
        "recordRows": [
          { "cells": [{ "field": "code" }, { "field": "name" }] }
        ]
      },
      "bind": { "dataset": "dsDept" }
    }
  ],
  "variables": {
    "busy": { "type": "boolean", "default": false },
    "message": { "type": "string", "default": "" }
  }
}
```

The file name gives the type name. `DepartmentList.form.json` gives the type `DepartmentList`. The `ver` column marks the version column, which the server uses to detect conflicts.

## 2. Run the check

```powershell
pnpm --filter demo exec fw check
```

`fw check` checks every form in the folder. It writes `DepartmentList.form.gen.ts` beside the form, with the types for the handler, and then runs `tsc`. Git ignores the generated file.

The first run reports that the script file is missing. That is expected, because the next step creates it.

## 3. Add the handler

Create `apps/demo/src/forms/DepartmentList.form.ts`:

```ts
import { TransactionError, defineForm } from '@fw/core';
import type { DepartmentList } from './DepartmentList.form.gen';

export default defineForm<DepartmentList>((form) => {
  const { dsDept } = form.ds;

  /** Loads every department from the server and says how many there are. */
  async function load(): Promise<void> {
    form.vars.busy = true;
    try {
      await form.tx.call({ service: 'hr.dept.list', outputs: { list: dsDept } });
      form.vars.message = `${dsDept.rowCount} departments`;
    } catch (error) {
      form.vars.message = error instanceof TransactionError ? `Failed: ${error.message}` : 'Failed: unexpected error';
    } finally {
      form.vars.busy = false;
    }
  }

  return {
    onInit: load,
    onReload: load,
  };
});
```

`defineForm<DepartmentList>` gets the Datasets, variables and handler names from the generated file. A missing handler is a compile error. Run the check again:

```powershell
pnpm --filter demo exec fw check
```

It should now report no errors. To list the form files that are not in the standard layout, run `pnpm --filter demo exec fw fmt --check`. Run `fw fmt` without `--check` to rewrite them.

## 4. Add the menu entry

Add this item to the `menu` list in `apps/demo/src/menu.ts`:

```ts
{ key: 'department-list', title: 'Department list', load: () => import('./forms/DepartmentList.form.json').then((m) => m.default) },
```

The shell builds its menu from this list. The import also brings in the handler, because the Vite plugin links each form to its script.

## 5. Run it with the fixture transport

```powershell
pnpm --filter demo dev
```

Open the address it prints, add `?fixtures` to it, for example `http://localhost:5173/?fixtures`, and choose "Department list" in the menu. The fixture transport answers from `apps/demo/src/fixtures.ts`, so the Grid shows the departments from the saved response. A service with no saved response returns the error `No fixture for service`.

## 6. Run it against the server

Stop the dev server, then start the demo, which runs the server and the dev server together:

```powershell
pnpm demo
```

Open the address it prints, without `?fixtures`. The server answers from `apps/demo/server/services.ts`. It already has `hr.dept.list`, so the new screen works without any server change. Choose Reload to call it.

To add a service of your own:

1. Declare it in `apps/demo/server/services.ts`, as the other services there are declared. For example:

   ```ts
   const departmentCodes = customService({
     id: 'hr.dept.codes',
     outputs: { list: { columns: [{ id: 'code', type: 'string', size: 10 }] } },
     handler: (ctx) => ({ datasets: { list: ctx.db.prepare('SELECT code FROM department ORDER BY code').all() } }),
   });
   ```

2. Add it to the `demoServices` array in the same file.
3. Add a saved response for it in `apps/demo/src/fixtures.ts`, so the fixture transport answers it too.
4. Restart `pnpm demo`. The server does not reload when its code changes. Run `pnpm demo:reset` only if you changed the seed data.

## 7. Open it in the designer

The designer needs the extension, installed as described in the README:

```powershell
pnpm vscode:package
pnpm vscode:install
```

In VS Code, right-click `apps/demo/src/forms/DepartmentList.form.json` and choose "Open with designer". The designer writes its changes to the JSON file as small text edits, so VS Code's undo works. The handler file is never changed by the designer.

The preview runs `DepartmentList.form.ts`. It runs only in a trusted workspace. To show data in the preview, add `DepartmentList.fixtures.json` beside the form. Use the same format as `apps/demo/src/forms/EmployeeEdit.fixtures.json`, with responses keyed by service id.

To try the designer in a browser instead, start its development page, after creating the form:

```powershell
pnpm exec vite --config packages/designer/dev/vite.config.ts
```

Then open `http://localhost:5196/dev/index.html?form=DepartmentList`. That page keeps the form in memory and writes nothing to disk.

## 8. Commit

Commit the new `.form.json` and `.form.ts` files, and your edits to `menu.ts`, `services.ts` and `fixtures.ts`. The `*.form.gen.ts` file is generated and ignored by Git. Run `pnpm check` before you commit.
