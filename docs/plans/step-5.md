# Step 5 plan: shell, popups and validation

Read [../FRAMEWORK.md](../FRAMEWORK.md) §4 and §5, [../REQUIREMENTS.md](../REQUIREMENTS.md) §2 (D3), §3.2 (FR-011 to FR-014), §3.3 (FR-026) and §3.5 (FR-063), and the rules at the top of [step-2.md](step-2.md), which still apply. The decisions in step-2.md, [step-3.md](step-3.md) and [step-4.md](step-4.md) still stand.

**Done when:** the demo opens in a shell with a menu and tabs; D1, D2 and D3 work in it against the real server; closing a tab or the page with unsaved changes warns first; a form can open another as a modal popup and get a typed result back; validation issues show on the field or cell they belong to; a loading indicator and a common error dialog cover every screen. All checks and browser tests pass.

**Agents are limited to the ones with the most impact:** three build, then `test-automator` and one reviewer.

## Decisions

1. **The shell is a core model plus a React view.** `createShell(options)` in `@fw/core` holds no DOM: tabs, the active tab, the popup stack, a busy count and the last unhandled error, all as signals. `AppShell` in `@fw/components` draws it. This keeps the shell testable without a browser, like forms.
2. **Tabs:** opening a menu item that's already open activates its tab instead of opening a second copy. A configurable limit (default 10) refuses a new tab with a message. Inactive tabs stay mounted with `hidden`, as Tabs pages do, so their state is kept (step 2 decision 3). The form lifecycle's `activate` and `deactivate` follow the active tab.
3. **Unsaved changes:**
   - **Closing a tab:** if the form has unsaved changes (`hasUnsavedChanges()`), the shell asks through its `confirm` option ("Discard unsaved changes in Employees?"). Only a yes closes it, and the form's own `beforeClose` can still veto.
   - **Closing or reloading the page:** with unsaved changes in any tab, the page sets `beforeunload`, and the browser shows its own warning.
4. **Popups:**
   - **Opening:** `form.open(entry, { params })` opens another form as a modal and resolves with its result, or `undefined` if the popup was cancelled. The popup is a full form, with its own Datasets, script and lifecycle.
   - **Closing:** `form.close(result)` closes the form it's called on. In a popup, that resolves the opener's promise with `result`. Esc or the close button cancels.
   - **Typing the result:** a form file can declare `result`, typed like `params`, and the generated type gives `form.open` and `form.close` a typed result.
   - **Stacking:** popups stack, and only the top one is interactive. The opener's own form stays open and keeps its state.
5. **Validation:**
   - `form.validate()` runs `validate()` on every Dataset that has rows to save, puts the issues on the Datasets with `setIssues`, and moves focus to the first one: an input bound to that column on the current row if there is one, otherwise the Grid cell. It returns the issues.
   - Server row errors go through the same path, so a script calls one helper for both.
   - Inputs and Grid cells already show issues (step 3). Checkbox and RadioGroup gain `errorMessage` and `required`, which they lack today.
6. **Required cue:** an input whose column or prop is required shows a visible marker on its label, in the theme, as well as `aria-required`.
7. **Global hooks (FR-063):**
   - **Loading indicator:** the shell wraps each tab's transport and counts calls in flight. `AppShell` shows a small indicator after a short delay (about 300 ms), so quick calls don't flicker.
   - **Common error dialog:** errors a script doesn't handle (from `fire` handlers and `onError`) open it, showing a plain message and never a stack trace. A `TransactionError` the script catches is the script's business.
8. **D3 lookup:** a reusable pattern made from parts that already exist, not a new component.
   - The demo builds a lookup popup form (`EmployeeLookup`) that searches employees on the server.
   - A screen uses it through a TextInput plus a Button. Typing a partial code and leaving the field searches first: a unique match fills in code and name with no popup, and otherwise the popup opens with the text as its search.
   - The popup returns `{ empNo, empName }`.
9. **The demo moves into the shell:** a menu with Employees (the edit screen), Employee list (D1) and Departments (D2). The hash routes stay as deep links that open the matching tab, so existing browser tests keep working.

## Work packages and ownership

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | typescript-pro | `packages/core/**`, `packages/format/**`, `packages/cli/src/gen.ts` and its tests | `createShell`, `form.open` and `form.close(result)`, the form file's `result` and its generated type, `form.validate()`, transport hooks |
| 2 | react-specialist | `packages/components/src/shell/**`, `packages/components/test/shell*`, `apps/demo/src/main.tsx`, `apps/demo/src/menu.ts` | `AppShell` (menu, tabs, popups, confirm dialog, loading indicator, common error dialog, `beforeunload`), the demo in the shell |
| 3 | frontend-developer | `packages/components/src/inputs/**`, `packages/components/test/inputs*`, `packages/components/src/theme/**`, `apps/demo/src/forms/**`, `apps/demo/server/services.ts` | Checkbox and RadioGroup validation, the required cue, using `form.validate()` in the screens, the D3 lookup popup and its use, and any lookup service it needs |

The shared contract is `packages/core/src/form/contract.ts` plus a new `packages/core/src/shell/contract.ts`, both owned by `typescript-pro`. The others build against the signatures in its first report, so it reports them as soon as they're settled.
