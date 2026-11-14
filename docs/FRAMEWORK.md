# Technical framework

**Status:** current. **Date:** 2026-11-07. Requirements are in [REQUIREMENTS.md](REQUIREMENTS.md).

**Evidence level:** nothing here has been built or measured. Performance numbers are targets, and effort numbers are judgement. `fw` and `DSX` are working names.

## 1. Architecture

```
 DESIGN TIME                              RUN TIME (browser)
┌───────────────────────────┐            ┌───────────────────────────────┐
│ VS Code custom editor      │            │ Shell: menu, tabs, popups     │
│  └ designer                │            ├───────────────────────────────┤
│     └ canvas iframe ───────┼─ same ───▶ │ components (React, React Aria)│
│       (real runtime,       │  runtime   │ grid (plain DOM)              │
│        design mode)        │            ├───────────────────────────────┤
├───────────────────────────┤            │ core (no DOM, no React)       │
│ Form source in Git         │            │  Dataset, bindings, signals   │
│  Emp.form.json   (tool)    │  fw build  │  form lifecycle, expressions  │
│  Emp.form.ts     (you)     ├───────────▶│  tx.call client, DSX codec    │
│  Emp.form.gen.ts (generated)│            └───────────────┬───────────────┘
└───────────────────────────┘                             │ POST /dsx/v1/tx/{serviceId}
                                                           ▼
                                          ┌───────────────────────────────┐
                                          │ Node server                   │
                                          │  validate, map row status to  │
                                          │  SQL, one DB transaction      │
                                          │        └ SQLite               │
                                          └───────────────────────────────┘
```

The core has no dependency on the DOM or React, so Dataset logic can be tested without a browser.

## 2. Technology decisions

| Area | Decision | Why |
|---|---|---|
| Language | TypeScript, strict, on both client and server | One language, and shared wire types |
| UI language | English only | The owner's goal for the project |
| Renderer | React 19 with React Aria. React types may appear in the API. No React Compiler | React Aria supplies ComboBox, DatePicker, Dialog and Tabs, which are slow to build well |
| Reactivity | `@preact/signals-core`, used directly | Small, and fits the React contract in §5.1 |
| Grid | Our own DOM grid on TanStack `virtual-core`, narrow scope | See §5.5 |
| Form source | Strict JSON, a TypeScript module, and generated types | Clean diffs, schema validation, normal debugging |
| Wire format | DSX/1: JSON with positional rows and change records | Readable and compact enough |
| Server | Node, Fastify, SQLite | One command from a clean clone, with no database to install. Database access sits behind a small interface, so PostgreSQL can be added |
| Designer host | VS Code custom editor, installed from a local `.vsix` | File saving, undo and text sync come free |
| Build | Vite, `tsc` for checks, a pnpm workspace | Standard. Needs Node 24 or later. TypeScript stays on 6.0 until `typescript-eslint` supports 7 |
| Tests | Vitest, Playwright, GitHub Actions | Free for a public repository |
| Licence | Apache-2.0 for everything | Permissive, with an express patent grant from contributors. Dependencies must be MIT, BSD, Apache-2.0 or ISC |

Nothing is published to npm, so package names are local to the repository.

## 3. Form format

Each screen has three files. `*.form.json` is written by the designer and can be edited by hand. `*.form.ts` is yours. `*.form.gen.ts` is generated and gitignored. This example is in the standard layout, and is the writer's test fixture.

```json
{
  "formatVersion": 1,
  "id": "hr.EmpSearch",
  "title": "Employee search",
  "script": "./EmpSearch.form.ts",
  "size": { "width": 1024, "height": 640 },
  "params": {
    "deptCode": { "type": "string" }
  },
  "events": { "init": "onInit" },
  "datasets": [
    {
      "id": "dsCond",
      "columns": [
        { "id": "deptCode", "type": "string", "size": 10 },
        { "id": "empName", "type": "string", "size": 50 }
      ],
      "initialRows": [{}]
    },
    {
      "id": "dsEmp",
      "keys": ["empNo"],
      "confirmUnsaved": true,
      "columns": [
        { "id": "empNo", "type": "string", "size": 10 },
        { "id": "empName", "type": "string", "size": 50 },
        { "id": "salary", "type": "decimal", "precision": 12, "scale": 0 },
        { "id": "hiredOn", "type": "date" }
      ]
    }
  ],
  "components": [
    {
      "id": "empNameInput",
      "type": "TextInput",
      "layout": { "left": 16, "top": 16, "width": 200, "height": 28 },
      "props": { "label": "Name", "maxLength": 50 },
      "bind": { "value": "dsCond.empName" }
    },
    {
      "id": "searchButton",
      "type": "Button",
      "layout": { "left": 232, "top": 16, "width": 80, "height": 28 },
      "props": { "text": "Search", "disabled": "=vars.busy" },
      "events": { "click": "onSearch" }
    },
    {
      "id": "empGrid",
      "type": "Grid",
      "layout": { "left": 16, "top": 56, "right": 16, "bottom": 16 },
      "props": {
        "columns": [
          { "id": "c1", "width": 90 },
          { "id": "c2", "width": 160 },
          { "id": "c3", "width": 120 }
        ],
        "headerRows": [
          {
            "cells": [
              { "text": "Employee", "colSpan": 2 },
              { "text": "Salary", "rowSpan": 2 }
            ]
          },
          {
            "cells": [
              { "text": "No" },
              { "text": "Name" }
            ]
          }
        ],
        "recordRows": [
          {
            "cells": [
              { "field": "empNo" },
              { "field": "empName", "editor": "text" },
              { "field": "salary", "format": "#,##0" }
            ]
          }
        ],
        "footerRows": [
          {
            "cells": [
              { "text": "Total", "colSpan": 2 },
              { "value": "=sum(salary)", "format": "#,##0" }
            ]
          }
        ]
      },
      "bind": { "dataset": "dsEmp" }
    }
  ],
  "variables": {
    "busy": { "type": "boolean", "default": false }
  }
}
```

```ts
// EmpSearch.form.ts
import { defineForm } from '@fw/core';
import type { EmpSearch } from './EmpSearch.form.gen';

export default defineForm<EmpSearch>((form) => {
  const onSearch = async () => {
    form.vars.busy = true;
    try {
      await form.tx.call({ service: 'hr.emp.search',
        inputs: { cond: form.ds.dsCond }, outputs: { list: form.ds.dsEmp } });
    } finally { form.vars.busy = false; }
  };
  return {
    onSearch,
    async onInit({ params }) {
      form.ds.dsCond.setValue(0, 'deptCode', params.deptCode ?? null); // names and types are checked
    },
  };
});
```

**Rules:**
- Ids are permanent. Array order is DOM and focus order. An optional `z` sets stacking.
- A Dataset can have `sampleRows`, which design mode loads instead of `initialRows`.
- The writer turns each change into minimal text edits, and unknown keys, key order and hand formatting elsewhere survive. Short objects stay on one line by schema key, never by width, so one property change is one line. JSON commas are the one exception: adding or removing the last key of a multi-line object also touches the line before it.
- Strict JSON only. Comments, trailing commas, duplicate keys and Git conflict markers make a file read-only until fixed, so the writer can never overwrite it.
- **Grid model:** `columns` are tracks (`id`, `width`, `frozen`). `headerRows`, `recordRows` and `footerRows` are rows of cells placed the way an HTML table does: implicit position plus `rowSpan` and `colSpan`. `recordRows` is an array so multi-line records can be added later without a format change, but for now the runtime rejects more than one row with a clear error.
- The format can change freely until a 1.0 tag, because the only forms are your own. After that, a format change needs a `formatVersion` bump and a migration.

## 4. Application model and Dataset

| Level | Owns |
|---|---|
| **Application** | Shared Datasets, variables, server URL, menu, theme |
| **Shell** | Tabs and where `open()` targets go |
| **Form instance** | Datasets, variables, script, bindings, popups, its own `AbortController` |
| **Components** | Properties, bindings, events |

**Lifecycle:** `loading`, `initializing` (`onInit`), `active`, `inactive`, `closing` (`onBeforeClose` can veto), `closed`. Closing aborts the form's pending calls. Modals return a typed `Promise<Result | undefined>`. Scopes are explicit: `form.ds.x`, `app.ds.codes`, `form.vars.busy`.

**Dataset:**
- One array per column, with stable row ids separate from positions. Row ids are never reused, even across a full reload, so a stale id throws instead of editing another row. Original values are copied on a row's first edit, deleted rows go to a hidden buffer, and a row whose edits are all reverted returns to normal.
- Filter and sort are private index views, read through `rowIdAt(index)`. `Intl.Collator` handles text sort.
- Decimals are stored as strings. Totals use scaled BigInt arithmetic, never doubles, and `load` never rounds or normalizes. If N-4 misses on decimal sort, add a scaled-integer cache.
- `date` is `YYYY-MM-DD`, and `datetime` is a zone-less `YYYY-MM-DDTHH:mm:ss`, optionally with fractional seconds.
- Current row: `currentRow` and `currentIndex` (−1 means none).
- Events: `currentRowChanging`, `currentRowChanged`, `cellChanging`, `cellChanged`, and a coalesced `onInvalidate({rows, columns, structural})`. Cancellable events accept `e.waitUntil(promise)` for async dialogs.
- After a save, each sent row is compared with what the server now holds. A row untouched since sending becomes normal. A row edited since sending stays updated, with the sent values as its new originals, so the edit is kept and the next conflict check is correct.

## 5. Runtime

### 5.1 React contract

A Dataset's contents change behind a stable reference, which can make React show stale values with no error. So:

- React never receives a Dataset or row.
- Each component host subscribes through `useSyncExternalStore` to one `computed` of its resolved props, with a shallow-equal cut-off. React gets plain props only.
- Grid cells are imperative and bypass React.
- Script calls such as `c.focus()` queue until React commits.
- Text inputs commit on blur or Enter, not per keystroke. Only typing creates a draft, and it belongs to the row it was typed on: if the row changes, it commits to that row, or is discarded if the row is gone. Text that doesn't fit the column stays on screen marked invalid. An edit a handler refuses goes back to the bound value.
- A lint rule bans React in `core` and `grid`.

### 5.2 Scripts and expressions

Scripts compile at build time. Handlers are returned from `defineForm`, so a missing handler is a compile error. `=` expressions use a small whitelisted evaluator with no `eval`, and they come only from form files in the build, never from data.

### 5.3 Layout and theme

Absolute positioning inside each container, with edges for anchoring (`left`, `top`, `right`, `bottom`, `width`, `height`, on one line). Theme values are `--fw-*` CSS variables. Dialogs and dropdowns use React Aria's overlays.

### 5.4 Components and design mode

Components are listed in FR-030, and their names come from HTML and WAI-ARIA. Each one has a bindable value, `disabled`, `readOnly`, a validation state and keyboard support.

Design mode is part of the runtime. `mode: 'design'` imports no script, builds no transport and loads sample rows. `applyPatch` replaces the top-level keys of one component's definition with no remount, except on a type change.

### 5.5 Grid

**Decision: build our own, narrow scope.** The Grid is the centre of the project, it reads the Dataset's columns directly, and its format is ours. The scope in §3.4 removes most of what made it expensive in the full-scope plan.

**Fallback: AG Grid Community (MIT), if P1 fails.** It was ruled out before because it doesn't document multi-line records and keeps range selection, clipboard and tree rows in its paid edition. Multi-line records, range selection and tree rows are now cut, and clipboard is a Could, which would have to be written ourselves on top of it. Its known Korean-input defect no longer matters, because the project is English only. It would add about 200–250 KB gz, and its sorting would need to be turned off in favour of the Dataset's.

**Engineering rules:**
- DOM rendering, no per-cell signals, no `innerHTML`, one code path for creating cells.
- Rows are created and destroyed as they scroll. Add a row pool only if N-4 misses.
- Row virtualization first. Add column virtualization only if N-4 misses.
- Focus stays on the Grid root, with `aria-activedescendant` on the active cell. A printable key opens an editor in an overlay, so scrolling can not destroy it.
- Frozen cells are sticky inside one row element.
- ARIA grid roles and a single tab stop, which cost little if built in from the start.

## 6. Transactions and server

### 6.1 Client API

`form.tx.call({ service, inputs, outputs, params, signal })` is async. Service ids are dotted (`hr.emp.save`). Inputs select `'all' | 'changed' | 'selected'` rows, where `all` means every live row whatever the filter, and `selected` comes with the Grid. Outputs apply `replace | append`. Server-assigned values in `applied` land on `changed` inputs. Errors are a typed `TransactionError` with per-row errors and a `committed` flag: `status.ok: true` means the server committed, so the save is accepted even if an output then can't be applied. One `changed` save can run per Dataset, and it waits for deferred edits first. An output doesn't replace a Dataset that still has edits made during its own save, and the result names it in `skippedOutputs`. Nothing retries automatically: after a network failure the user sees "outcome unknown" and keeps their edits.

### 6.2 DSX/1

`POST /dsx/v1/tx/{serviceId}`, with one service per request and no batch endpoint.

```json
{ "dsx": 1, "txId": "01JBZ8Q4W3T6K9M2N5P7R1S3V4", "service": "hr.emp.save",
  "params": { "deptCode": "D010" },
  "datasets": { "dsEmp": {
    "columns": [
      { "id": "empNo", "type": "string", "size": 10, "key": true },
      { "id": "empName", "type": "string", "size": 50 },
      { "id": "salary", "type": "decimal", "precision": 12, "scale": 0 },
      { "id": "ver", "type": "int", "version": true }
    ],
    "changes": [
      { "s": "U", "id": 3, "v": ["E1001", "Minji Kim", "5200000", 7], "o": { "1": "Minju Kim" } },
      { "s": "I", "id": 9, "v": [null, "Jun Lee", "4100000", null] },
      { "s": "D", "id": 5, "v": ["E0999", "Seojun Park", "3900000", 3] }
    ] } } }
```

- A dataset sends either `changes`, or `rows` (positional) with `ids` beside them giving each row's client id.
- `s` is `I`, `U` or `D`. `id` is the client row id. `o` maps column index to original value, so its keys are the changed columns. Decimals travel as strings.
- **Responses** carry `status {ok, code, message}`, `params`, `datasets` (`columns` and positional `rows`, matched to the client's columns by id), `applied` (server-assigned values: input Dataset name, then client row id, then column) and `errors[]` (`dataset`, `id`, `column`, `code`, `message`). Raw database messages and stack traces are never sent. HTTP codes: 200, 400, 404, 409 for a conflict, 422, 500.
- `txId` is an opaque string for logs only.

### 6.3 Server

| Stage | Behaviour |
|---|---|
| Entry | Listens on `127.0.0.1` by default, with a body size limit and JSON only |
| Resolve | Registry lookup, plus an `authorize(request, service)` hook that allows everything by default |
| Validate | Unknown columns are rejected. All rows are validated before any write |
| Transaction | One request is one database transaction, all or nothing |
| Persist | Deletes, then updates, then inserts within a Dataset; declared order across master and detail. Updates set only the columns in `o` |
| Finish | Errors mapped to DSX |

- **Services:** `tableService` declares a table, keys and columns, and generates parameterized SQL. `customService` is a hand-written handler with the same transaction and a conflict-check helper.
- **Conflicts:** a version column if present, otherwise all loaded columns, skipping blobs and floats. A zero-row update is a conflict.
- **Exact decimals on SQLite:** SQLite has no exact decimal type, and `NUMERIC` can round values through a float. Declare decimal columns as `TEXT` and pass strings. SQL `SUM` and `ORDER BY` on these columns aren't exact, so totals come from the Dataset or from a `customService` written for it.

## 7. Designer and tooling

**Designer.** A browser package behind a thin `DesignerHost` interface, with VS Code as the only host for now. The canvas renders the real runtime in an iframe in design mode, and selection and guides are a separate overlay. One `defineComponentMeta` source, free of React, drives the palette, inspector and semantic checks. The JSON Schema is written by hand and covers structure. Each gesture is one VS Code edit, so native undo works.

Dragging changes only a component's position. It never changes its parent or sibling order, which are changed by explicit commands in an outline panel. Dropping from the palette chooses the parent when the component is created.

**CLI.** `fw dev`, `fw build`, `fw check` (schema, semantic checks, `tsc --noEmit`), `fw fmt`.

**Workspace.** `packages/core`, `format` (schema, validation, writer), `components`, `grid`, `cli`, `designer`, `server`; `apps/demo`, `apps/vscode`. `format` is separate from `cli` because the designer needs it in the browser, so it has no file system code.

## 8. Proof tests

These cover the riskiest assumptions, and each runs before the work that depends on it.

| ID | Test | Pass | When | If it fails |
|---|---|---|---|---|
| P1 | Grid | 100k × 20 meets N-4. Merged headers, left freeze, text and number editors, full keyboard model, and typing on a focused cell starts editing. 1,000 scripted edits leave the DOM matching the Dataset | First thing in step 3 | Switch to AG Grid Community |
| P2 | Form writer | Zero diff with no change, one-line diff per property, unknown keys survive, conflicted file is read-only | Step 1, then again in step 6 | Change the format |
| P3 | Signals and React | 300 components from JSON. 1,000 scripted changes leave the DOM matching the Dataset. A hidden tab shows the latest values when revealed | Step 2 | Rework the component host |
| P4 | Value round trip | Long decimals, dates, and empty string vs null all round-trip through SQLite with zero false conflicts, and a real conflict is caught | Step 4 | Per-type mapping |

## 9. Build order and effort

| Step | Build | Demo at the end | Full-time months |
|---|---|---|---|
| 1 | Repository, Dataset, schema, form writer. **Done 2026-11-07** | Tests only | 1–1.5 (steps 1 and 2 together) |
| 2 | Runtime, binding, components, CLI, fixture transport. **Done 2026-11-07** | A form runs from JSON with fake data | |
| 3 | Grid. **Done 2026-11-13** | D1 on fixture data | 2–3 |
| 4 | Transactions, server, SQLite. **Done 2026-11-14** | D1 and D2 on a real database | 0.5–1 |
| 5 | Shell, popups, validation. **Done 2026-11-14** | D3 | 1–1.5 |
| 6 | Designer | D4 | 2–3 |
| 7 | Publish checklist (§10) | Public repository | Days |
| | **Total** | | **6.5–10** |

This is one person's judgement with low confidence, assuming one developer working full-time without AI help. How much AI help shortens it is unmeasured, so replace these numbers with real pace after step 2.

Step 5 can move after step 6 if you want the designer sooner. D3 needs it, but D4 doesn't.

## 10. Public repository rules

**Always:**
- Don't install, run or read the code, runtime, IDE or documentation of any commercial platform in this category.
- Use only the names in these two documents, which come from HTML, WAI-ARIA and general conventions.
- Don't build importers or wire compatibility for a commercial product's formats.
- Don't name a commercial platform in the product name, or describe this project as compatible with one, a version of one or a successor to one.

**Before the first public push:**
1. Pick a name, and search GitHub and the web for collisions.
2. Add `LICENSE` (Apache-2.0). Without one, others have no right to use the code.
3. Write a README: what it is, how to run it, that it has no login and is not production-ready.
4. Leave out `docs/research/` and `.claude/agents/`. The research files are private notes, and the agent files are third-party prompts.
5. Replace the `CLAUDE.md` description with neutral wording.
6. Check dependency licences with a licence-checking tool.
7. Start from a fresh Git history, and scan it for secrets.

## 11. Open decisions

The product name is the only one left. Decide it before the first public push.

Settled by the owner on 2026-11-07: the backend is Node and TypeScript, and the project is English only.
