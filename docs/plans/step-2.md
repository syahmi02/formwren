# Step 2 plan: a form runs from JSON with fake data

Read [../FRAMEWORK.md](../FRAMEWORK.md) and [../REQUIREMENTS.md](../REQUIREMENTS.md) first. This plan adds the detail needed to build in parallel.

**Done when:** a form written as JSON runs in a browser with data from the fixture transport, its inputs edit a Dataset both ways, and proof test P3 passes.

## Rules for everyone

- **Project root:** `C:\dev\fw-platform`. Use absolute paths, and start every shell command with `cd /c/dev/fw-platform &&`.
- **Don't read `docs/research/`.** It's private and not a spec. Don't look at, install or run any commercial platform in this category. Take names from HTML, WAI-ARIA, or these documents.
- **Stay in your own files.** Others are writing the rest right now. See the ownership table.
- **Contracts:** `packages/core/src/form/contract.ts`, `packages/core/src/expr/contract.ts`, `packages/core/src/tx/contract.ts`, `packages/core/src/form/meta.ts` and `packages/components/src/contract.ts`. Build against them. If one truly needs to change, make the smallest additive change and report it.
- **Dependencies are installed already,** and parallel installs would collide. Don't run `pnpm add` or `pnpm install`. If something's missing, work around it and report it. Available: `@preact/signals-core`, `react`, `react-dom`, `react-aria-components`, `@internationalized/date`, `vite`, `@vitejs/plugin-react`, `tsx`, `typescript`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@playwright/test`.
- **Don't change** root config (`package.json`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `pnpm-*`), `CLAUDE.md`, or `docs/`. Report what you need instead. Don't run Git commands.
- **Testing:** run only your own tests, such as `pnpm exec vitest run packages/core/test/form`. Files by others may be half-written, so judge `tsc` only on errors in your files. If something you depend on isn't there yet, use a small test double that follows the contract, and say so in your report.
- **Typed Datasets:** `Dataset<C>` takes a map of column names to value types. Generated form types use it: string, date, datetime and decimal columns are `string`, int and float are `number`, boolean is `boolean`.
- **Quality:** TypeScript strict. No `eval` or `new Function`. No `innerHTML`. English for all text. Comments only where the reason isn't obvious.
- **Your final report** covers only what you actually did and verified: files changed, test results as run, contract changes, anything you doubt, and decisions you think the lead should make. No invented metrics.

## Decisions made for this step

1. **Text inputs commit on blur or Enter,** not on each keystroke. The input holds a local draft while focused, Esc restores the bound value, and a false result from `write` goes back to the bound value. This keeps row status and `cellChanging` meaningful, and avoids React's caret problem with async updates to controlled inputs. Selection controls (Checkbox, RadioGroup, ComboBox) write straight away.
2. **The model parses text.** `write` takes a string from an input and turns it into the column's type. `NumberInput` is a text field, not React Aria's NumberField, which parses to a double and would lose digits on a decimal column. It sends text and receives text or a number.
3. **Hidden tabs stay mounted,** using the `hidden` attribute. They keep updating, so they're current when shown. `<Activity>` isn't used, because it destroys Effects.
4. **Tabs' children are its pages.** Each child is usually a Panel with layout `{ left: 0, top: 0, right: 0, bottom: 0 }`, and the tab label is its `title` prop.
5. **Bind values:** a key whose meta says `column` holds `dataset.column`, read from the current row. A key whose meta says `dataset` holds a Dataset id. ComboBox and RadioGroup can use `bind.options` with `props.optionValue` and `props.optionLabel`, which resolve to a plain `options: { value, label }[]`, cached until that Dataset changes. Static `props.options` also works.
6. **Expressions:**
   - Literals, `vars.x`, `params.x`, `ds.name.column`, `ds.name.$currentIndex`, `ds.name.$rowCount`, `! - + * / %`, comparisons, `&& ||`, `?:`, parentheses, `sum avg min max count`, and `concat(a, b, ...)`, `round(a, scale)`, `div(a, b, scale)`.
   - No silently wrong decimals. `+ - *` on numbers is normal. If either side is decimal-looking text, the result is exact text from the decimal functions. Any other string with an arithmetic operator is an error, so `concat` is how to join strings. `/` is numbers only, and `div` is the exact version.
   - `< <= > >=`: two numbers compare numerically, two decimal-looking strings compare exactly, any other two strings compare ordinally. `==` and `!=` are strict.
   - Runtime errors go to `onError` once per expression and give `undefined`, so a bad expression can't break rendering.
7. **Design mode:** imports no script, builds no transport, and loads `sampleRows` instead of `initialRows`. `write` returns false, `fire` does nothing, and `tx.call` rejects.
8. **The Grid is step 3.** `FormView` draws a labelled placeholder for any type missing from the registry, so forms that use a Grid still run.
9. **`inputs` row selection:** `all` or `changed`. `selected` needs Grid selection, so it comes in step 3.
10. **DatePicker is single-date.** Date ranges are two DatePickers.

## Styling contract

- The host wraps each component in `div.fw-host`, absolutely positioned from its layout edges. Children are positioned relative to their parent container.
- Each component's root has `fw-<lowercase type>`, such as `fw-textinput`, and fills the host (100% width and height).
- Inner parts use `fw-<type>__<part>`, such as `fw-textinput__label`. State comes from React Aria's `data-*` attributes (`data-focused`, `data-disabled`, `data-invalid`, ...).
- Components ship no CSS of their own, and all visual styling is in `packages/components/src/theme/`. Values come from `--fw-*` variables.

## Work packages and ownership

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | typescript-pro | `packages/core/src/form/**` (not `meta.ts`), `packages/core/test/form*` | `createForm`, `openForm`, `defineForm`, variables, lifecycle, `ComponentModel`, bindings, text parsing, design mode |
| 2 | fullstack-developer | `packages/core/src/expr/**`, `packages/core/src/tx/**`, `packages/core/test/expr*`, `packages/core/test/tx*` | Expression parser and evaluator, DSX codec, `createTxClient`, `fixtureTransport`, test vectors |
| 3 | react-specialist | `packages/components/src/host/**`, `src/containers/**`, `src/meta/containers.ts`, `test/host*`, `test/containers*` | `FormView`, host hook, layout, registry lookup, handles, error boundary, Panel, Tabs, Dialog |
| 4 | frontend-developer | `packages/components/src/inputs/**`, `src/meta/inputs.ts`, `test/inputs*` | Label, Button, TextInput, NumberInput, TextArea, Checkbox, RadioGroup, ComboBox, DatePicker, with their metas |
| 5 | tooling-engineer | `packages/cli/**`, `packages/format/src/validate.ts`, `packages/format/test/validate*`, `apps/demo/**` (not `gallery/`) | `fw check`, `fw fmt`, `fw dev`, `fw build`, Vite plugin, `.form.gen.ts` generator, demo app |
| 6 | ui-designer | `packages/components/src/theme/**`, `packages/core/src/display/**`, `packages/core/test/display*`, `apps/demo/gallery/**` | Dense default theme, `formatValue`, component gallery page |

## Stage 2 decisions, after the first build

11. **Text that doesn't fit vs a cancelled edit.** `accepts(prop, value)` tells them apart. Text that doesn't fit stays on screen, marked invalid. An edit a handler cancels goes back to the bound value.
12. **One error path.** Hosts report through `form.reportError`, and `FormView` has no `onError` prop.
13. **`FormHandler` takes `any`** so `onInit({ params })` compiles. Typed payloads per handler can come later through the generator.
14. **Unsaved-change warnings belong to the shell** (step 5). `close()` only runs `beforeClose`.
15. **`pnpm typecheck` generates form types first,** because `*.form.gen.ts` is gitignored. `fw check` fails if a type file can't be written.
16. **A version column needs a way to be declared.** Comes with the server in step 4.

## Stage 4 decisions, after the reviews

17. **A draft belongs to the row it was typed on.** Focus alone creates no draft: only typing does, and an unedited field always shows the bound value. If the row changes while a draft is edited, the draft commits to its original row straight away and the field shows the new row. If that row is gone, the draft is discarded.
18. **Row ids are never reused,** even across a full reload. A stale id throws `RangeError`, so it can't silently edit another row.
19. **`rows: 'all'` means every live row,** whatever the filter, and sends `ids` beside `rows` so server errors map to the right row.
20. **`status.ok: true` means the server committed.** The save is accepted first, whatever happens next. If an output then can't be applied, the call rejects with `committed: true`.
21. **One running save per Dataset.** A second `changed` save of the same Dataset rejects with `duplicate`, through any service. `tx.call` waits for deferred edits to settle before sending.
22. **An output never replaces edits made during its own save.** If a Dataset is both a `changed` input and an output and still has changes after accepting, it isn't replaced, and the result names it in `skippedOutputs`.
23. **Overrides and expressions.** A write to a prop driven by an `=` expression holds until that expression's value next changes.
24. **A later edit to a cell supersedes an earlier one still waiting on a handler.** The earlier write resolves false.
25. **Expression truthiness is plain:** only `null`, `undefined`, `false`, `0` and `''` are false, so decimal text like `"0.00"` is true. Compare explicitly with `> 0`.
26. **A `beforeClose` that throws vetoes the close,** so unsaved edits are never dropped by a bug in the guard.
27. **`tabIndex` is removed,** because array order is focus order. `z` is honoured.
28. **Accepted as they are:** React Aria clamping an impossible date (the corrected date is visible), a Checkbox that went from null to true to false staying dirty, and `fw fmt` writing LF with no byte order mark.
29. **Moved to step 3's contract work,** since the Grid is what needs them: per-cell issues and `focus(cell)`, Grid cell `kind` and options, row selection and `selected`, `cellScope` for footers, and moving `placeGridCells` to core.

## After the build

The lead integrates, then test-automator runs P3 and browser tests, and reviewers check the result. Fixes go back to the agent that owns the code.
