# Step 3 plan: the Grid

Read [../FRAMEWORK.md](../FRAMEWORK.md) §3 (Grid model) and §5.5, [../REQUIREMENTS.md](../REQUIREMENTS.md) §3.4 and N-4, and the rules at the top of [step-2.md](step-2.md), which still apply. Decisions 1 to 29 there still stand.

**Done when:** D1 works on fixture data (search, Grid fills, sort, resize columns, footer totals), every Must in §3.4 works, and proof test P1 passes. If P1 fails, the lead takes the AG Grid fallback to the owner.

**Agents are limited to the ones with the most impact,** at the owner's request: four build, then `test-automator` runs P1, then one review.

## Decisions

1. **Focus stays on the Grid root.** It has `role="grid"`, `tabindex="0"` and `aria-activedescendant` pointing at the active cell. There's no input in the cell until editing starts. A printable key opens the editor with that character, and Enter or F2 opens it with the current value. This is the standard ARIA pattern, and with English only there's no composition problem to solve. It replaces the "real input in the active cell" rule that FRAMEWORK §5.5 used to have.
2. **The active row stays rendered** while scrolled away, through virtual-core's `rangeExtractor`, so `aria-activedescendant` stays valid.
3. **Editors live in an overlay,** never in a cell. Rows are created and destroyed as they scroll, so an editor inside one would lose focus and the draft.
4. **One scroller.** `.fw-grid__scroller` is the only scroll container. The header and footer are `position: sticky` inside it, and frozen cells are `position: sticky` inside their row element, so the ARIA structure holds.
5. **Row layout:** each row and the header and footer are CSS grids with the same `grid-template-columns` from track widths. Rows are absolutely positioned with `translateY`, at one fixed row height from a `--fw-grid-row-height` token.
6. **Rendering rules from FRAMEWORK §5.5 hold:** no per-cell signals, no `innerHTML`, one code path for creating cells, rows created and destroyed as they scroll, row virtualization only. Text uses `textContent`.
7. **Row identity:** a cell is `{ rowId, track }`, because positions change when sorting. The active cell follows its row through sort and filter. The active row is the Dataset's current row, so moving rows goes through `setCurrentIndex`, which handlers can refuse or defer. A refusal keeps the active cell where it was.
8. **Editing:** writes go through `writeCell`, and `acceptsCell` is checked first. Text that doesn't fit stays in the open editor marked invalid. A refused write closes the editor and shows the stored value. Enter commits and moves down, Tab commits and moves right (wrapping to the next row), Esc cancels, and leaving the Grid commits. An editor belongs to the row it was opened on (step 2 decision 17): if that row disappears, the draft is discarded.
9. **Sorting** goes through `dataset.sort`. Clicking a header sorts ascending, then descending, then none. Shift-click adds a key. It works on a header cell over a track whose record cell has a `field`, and `aria-sort` shows the state.
10. **Column resize** is a drag handle on a header cell's right edge. Width is held in the Grid's own state for now and isn't written to the form.
11. **Cell kinds:** `kind: 'rowStatus'` draws the row's status, and `kind: 'rowSelect'` draws a checkbox tied to the Dataset's row selection. `editor: 'dropdown'` and code-to-name display use `options`, `optionValue` and `optionLabel` on the cell, where `options` is a Dataset id or a static `{ value, label }[]`.
12. **Validation markers:** a cell with an issue from `dataset.issueAt(rowId, column)` gets `data-invalid` and `aria-invalid`, with the message as `title`. `GridHandle.focus(cell)` is how Save moves to the first error.
13. **Footers** evaluate `value` expressions through `GridOptions.scope`, with exact totals from the Dataset. A footer repaints when its Dataset changes, batched per render.
14. **Design mode** draws sample rows, attaches no behaviour, and reacts to `update(definition)` with no remount.
15. **CSS:** all visual styling is in `packages/components/src/theme/`, using `--fw-*` tokens. Class names are `fw-grid`, `fw-grid__scroller`, `__header`, `__body`, `__footer`, `__row`, `__cell`, `__overlay`, `__editor`, `__resize`. State uses `data-*`: `data-active`, `data-current`, `data-frozen`, `data-status`, `data-invalid`, `data-selected`.

## Core additions, from the architecture review

These land first, because the Grid builds on them:
- **Issues on the Dataset:** `setIssues(issues)`, `issueAt(rowId, column)`, `issues()`. An issue clears when its cell is written, and all clear on a replacing load or revert. A change notifies through invalidation. `ValidationIssue.code` widens to `string`.
- **Selection on the Dataset:** `setRowSelected(rowId, selected)`, `isRowSelected(rowId)`, `selectedRows()`, `clearSelection()`. Selection never changes row status, is cleared on a replacing load, and drops a row that goes. `TxRowSelection` gains `'selected'`.
- **`ComponentModel.cellScope(key = 'dataset'): ExpressionScope`:** form reads, plus one-segment aggregate paths on the bound Dataset.
- **`readOptions`,** the shared options reader, exported from core.
- **Column-bound props** take `errorMessage` from `issueAt` when there is one, so `setIssues` reaches inputs.
- **`ComponentHandle.focus(cell?)`.**

## Work packages and ownership

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | typescript-pro | `packages/core/**`, `packages/format/**` | Core additions above, Grid format additions and checks |
| 2 | performance-engineer | `packages/grid/src/engine/**`, `packages/grid/test/engine*`, `packages/grid/bench/**`, `packages/components/src/theme/grid.css` | `createSurface`: rendering, virtualization, frozen columns, merged headers, footers, resize, painting, ARIA structure |
| 3 | frontend-developer | `packages/grid/src/interaction/**`, `packages/grid/test/interaction*`, `packages/components/src/theme/grid-editors.css` | `attachBehavior`: keyboard, active cell, editors, selection, sorting |
| 4 | react-specialist | `packages/components/src/grid/**`, `packages/components/src/meta/grid.ts`, `packages/components/test/grid*`, `apps/demo/src/**` | React host for the Grid, its meta, and the D1 demo screen |

`packages/grid/src/contract.ts` is the seam between 2, 3 and 4. Make only small additive changes to it, and report them. `packages/grid/` has no React.
