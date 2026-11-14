# Requirements

**Status:** current. **Date:** 2026-11-07. The technical design is in [FRAMEWORK.md](FRAMEWORK.md).

**Scope:** personal use. The most this project will ever be is a public GitHub repository. It does not need every feature of commercial platforms in this category. It passes when the main features work and are sound, as defined in §2. The UI, messages and docs are in English only.

**Evidence level:** nothing has been built or measured yet, so all numbers are targets.

**Conventions:** **Must** counts toward done. **Could** is optional and never blocks done. IDs match the archived full-scope requirements, so gaps are expected.

## 1. Goal

A small platform for building data-heavy business screens. A screen is defined in a text file or a visual designer, runs in a browser with no install, edits rows through a Dataset and Grid, and saves all its changes with one call to a server.

The six main features:

1. **Form format:** screens as text files that diff cleanly in Git.
2. **Runtime:** renders those files in the browser.
3. **Dataset and binding:** typed rows in memory that track every change.
4. **Grid:** edits and displays many rows from the keyboard.
5. **Transactions and server:** saves all changes together or none of them.
6. **Designer:** edits a form visually and writes clean text back.

## 2. Definition of done

The project is done when all three of these hold:

1. Every Must in §3 works.
2. The demo app runs from a clean clone with one command, on a real database, and these four journeys work:

   | ID | Journey | Passes when |
   |---|---|---|
   | D1 | Search and list | Enter conditions, press Search, and the Grid fills. Sort, resize columns and see footer totals |
   | D2 | Master-detail editing | Selecting a master row loads its details. Add, edit and delete rows in the Grid and a form. Save sends the changed rows of both Datasets in one transaction. Errors mark the right cell, and data refreshes on success |
   | D3 | Lookup popup | A partial code or a button opens a modal search. A unique match fills in automatically. The popup returns code and name |
   | D4 | New screen in the designer | Build a screen visually, write its handler in TypeScript, run it, and commit. The diff is small and readable |

3. The soundness checks in §4 pass.

## 3. Functional requirements

### 3.1 Form format

| ID | Requirement | Pri |
|---|---|---|
| FR-001 | A JSON form file defines components, properties, layout, Datasets, bindings and handler references | Must |
| FR-002 | A JSON Schema validates form files in the CLI and designer | Must |
| FR-003 | Deterministic output: stable key and component order, no volatile ids or timestamps. Unknown keys survive writes | Must |
| FR-004 | Handlers live in a companion TypeScript file and are referenced by name, never embedded as strings | Must |
| FR-006 | Every file has a `formatVersion`. Migration functions are needed only after a 1.0 tag | Must |
| FR-005 | Reusable sub-forms with parameters | Could |

### 3.2 Runtime

| ID | Requirement | Pri |
|---|---|---|
| FR-010 | The browser runtime loads and renders forms with no plugin or install | Must |
| FR-011 | Shell: a simple menu and tabs, with state kept when switching tabs | Must |
| FR-012 | Unsaved-change warning on tab close and page close | Must |
| FR-013 | Modal popups: arguments in, typed result out | Must |
| FR-014 | Lifecycle events: init, before-close (can veto) and close. Closing a form cancels its pending calls | Must |
| FR-016 | Absolute positioning with edge anchoring for resize | Must |
| FR-030 | Components: Label, Button, TextInput, NumberInput, TextArea, Checkbox, RadioGroup, ComboBox, DatePicker, Panel, Tabs, Dialog | Must |
| FR-085 | Form scripts in TypeScript, compiled at build time, with a typed API | Must |
| FR-086 | No `eval` or `new Function`. Expressions use a safe evaluator | Must |
| FR-090 | A dense default theme built on CSS variables | Must |
| FR-093 | `Intl`-based number and date formatting | Must |
| FR-100 | CLI: dev server, build and check, with a non-zero exit code on failure | Must |
| FR-101 | Build output is static files | Must |
| FR-017 | Flex and stack containers | Could |
| — | MaskedInput | Could |

### 3.3 Dataset and binding

| ID | Requirement | Pri |
|---|---|---|
| FR-020 | Typed columns: string, int, decimal, float, boolean, date, datetime | Must |
| FR-021 | Row status (normal, inserted, updated, deleted), original values, deleted-row buffer, and revert per row or per Dataset | Must |
| FR-022 | Add, insert and delete rows; find; filter; multi-key sort; aggregates; bulk load | Must |
| FR-023 | Cancellable current-row and cell-value events. A handler can defer the decision to an async dialog | Must |
| FR-024 | Two-way binding of a component to a column of the current row. Grid bound to a whole Dataset | Must |
| FR-025 | Exact decimal arithmetic, including totals | Must |
| FR-026 | Column validation (required, length, range, pattern, custom function), shared by inputs and Grid | Must |
| FR-027 | Computed columns | Could |

### 3.4 Grid

| ID | Requirement | Pri |
|---|---|---|
| FR-040 | Dataset-bound Grid with header, record and footer rows; number, date and code-to-name formats | Must |
| FR-041 | Row virtualization that meets N-4 | Must |
| FR-042 | Multi-row merged headers; frozen left columns | Must |
| FR-043 | Text, number, dropdown, date and checkbox editors. Arrows, Tab, Enter, F2 and Esc work. Typing on a focused cell starts editing | Must |
| FR-044 | Row-status column, checkbox column, single-row selection | Must |
| FR-045 | Column resize; multi-column sort from the header | Must |
| FR-046 | Footer sum, average and count | Must |
| FR-048 | Cell validation markers. Save moves focus to the first error | Must |
| FR-047 | xlsx export of what the Grid shows, with formula-injection escaping | Could |
| FR-049 | Copy and paste ranges with Excel | Could |
| FR-050 | Column filter UI | Could |
| FR-052 | Conditional cell styling | Could |

### 3.5 Transactions and server

| ID | Requirement | Pri |
|---|---|---|
| FR-060 | One call sends N input Datasets (all, changed or selected rows) plus parameters, and returns M output Datasets plus a result code and message | Must |
| FR-061 | A short written wire-format spec, with test vectors | Must |
| FR-062 | Standard error format, including row and column errors mapped to Dataset cells | Must |
| FR-063 | Global hooks for the loading indicator and common error dialog | Must |
| FR-064 | Timeout, cancel and duplicate-submit prevention | Must |
| FR-065 | The server maps row status to parameterized INSERT, UPDATE and DELETE in one database transaction, and query results to output Datasets | Must |
| FR-066 | Fixture transport that answers from saved responses, for preview and tests | Must |
| FR-067 | Conflict detection: version column if present, otherwise all loaded columns. A zero-row update is reported as a conflict on that row | Must |
| FR-068 | Paged fetch that appends to a Dataset | Could |

### 3.6 Designer

| ID | Requirement | Pri |
|---|---|---|
| FR-070 | Canvas on the real runtime: palette, add, select, move, resize, delete, undo and redo, snap | Must |
| FR-071 | Property inspector generated from component metadata, with typed editors and a binding picker | Must |
| FR-072 | Dataset editor: columns, types, sample rows | Must |
| FR-074 | Live preview on the real runtime with the fixture transport | Must |
| FR-075 | Edit Grid columns in the inspector: add, remove, width, field, format, editor. Merged headers are edited in the JSON | Must |
| FR-077 | Text and canvas stay in sync: outside edits reload without loss, and a file with merge conflicts opens read-only | Must |
| FR-078 | Runs as a VS Code custom editor, installed from a local `.vsix` | Must |
| FR-073 | "Create handler" from the inspector | Could |
| — | Multi-select, align, copy and paste | Could |

## 4. Soundness checks

"Sound" means these hold. Everything except N-4 runs in CI.

| ID | Check | How it's verified |
|---|---|---|
| N-1 | **No wrong or lost data.** Row status and original values stay correct, revert restores the original, and decimals never lose digits. A failed save keeps edits and row status. Edits made during a save aren't overwritten | Unit tests, plus an end-to-end test of D2 |
| N-2 | **All or nothing.** If the last row of a save fails, the database is unchanged | Integration test on the real database |
| N-3 | **No silent overwrites.** A row changed by someone else since it was loaded is reported as a conflict | Integration test |
| N-4 | **Works at size.** 100,000 rows × 20 columns: first paint ≤ 1 s, no visible lag scrolling or moving between cells, sort ≤ 1 s | Measured by hand on the owner's PC. A miss means tuning or a lower limit, not failure |
| N-5 | **Clean files.** Saving with no change gives a zero diff. One property change is a one-line diff. Unknown keys survive | Round-trip tests |
| N-6 | **Safe by default.** Parameterized SQL only, no `eval`, data rendered as text. The server listens on localhost by default, and the README says it has no login | Tests and code review |
| N-7 | **Maintainable.** TypeScript strict mode, and CI runs types, lint, unit tests and the end-to-end demo | CI |
| N-8 | **Browsers.** Current Chrome and Edge | End-to-end tests on Chromium, plus a manual check in Edge |

## 5. What was cut

The full-scope version had 103 functional and 33 non-functional requirements. These parts existed for a commercial product, so they're out unless the trigger applies.

| Cut | Comes back if |
|---|---|
| Market, design partner, pilot, pricing, adoption metrics | It becomes a product |
| Lawyer, patent review, second signer, CI name denylist, attestations | It becomes a product, or others start relying on it commercially |
| Security and accessibility certification work: ASVS Level 2, secure-coding guide, SBOM, outside diagnosis, WCAG audit | It's hosted for other people |
| Login, roles, SSO, personal-data masking, audit logs | It's hosted for other people |
| Offline kit, reference PC, Firefox, Safari and other browsers | You need one of them |
| Multi-line records, tree rows, merged cells, right-frozen columns, range selection | You need one on a real screen |
| Printing, file upload, Excel import, charts, undo at Dataset level | You need one on a real screen |
| Java/Spring adapter, retry store, streaming responses | You need one. The wire spec allows a second backend later |
| Browser-hosted and desktop designer, per-form deploy, AI generation, mobile | You need one |
| Korean and other languages, translation resources | You change the goal. English only is the point of the project |
