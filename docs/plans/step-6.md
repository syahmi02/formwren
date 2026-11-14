# Step 6 plan: the visual designer

Read [../FRAMEWORK.md](../FRAMEWORK.md) §3, §5.4 and §7, [../REQUIREMENTS.md](../REQUIREMENTS.md) §2 (D4) and §3.6 (FR-070 to FR-078), and the rules at the top of [step-2.md](step-2.md), which still apply. The decisions in steps 2 to 5 still stand.

**Done when:** D4 works. That means building a screen visually in VS Code, writing its handler in TypeScript, running it, and committing it with a small readable diff. Every Must in §3.6 works, P2 passes on the designer, and all checks and browser tests pass.

**Two stages, so the owner can try it early:**
- **Stage A, a first usable designer:** open a `*.form.json` in VS Code and see the canvas. Select, move, resize, delete, snap and nudge with the keyboard. Edit properties in an inspector. Undo and redo through VS Code. Text and canvas stay in sync, and a file with conflicts opens read-only.
- **Stage B, the rest:** a palette to add components, an outline to re-parent, reorder and rename, the Dataset editor, the Grid columns editor, the binding picker, and a live preview with fixtures.

## Decisions

1. **The text is the only source of truth.**
   - The designer never keeps its own copy of the form.
   - Every gesture computes the next form from the current text, turns it into minimal text edits with `diffFormText`, and asks the host to apply them as one undoable step.
   - When the text changes for any reason (a gesture, typing in the text editor, undo, redo, Git), the designer re-parses it and redraws.
   - So VS Code's own undo and redo just work, and the designer can never drift from the file.
2. **`DesignerHost`** (in `packages/designer/src/contract.ts`) is the only way the designer talks to its host: read the text, apply edits, hear about outside changes, and know whether the file is read-only. VS Code is the real host. A small browser host backed by memory exists for development and browser tests.
3. **The canvas is the real runtime in an iframe, in design mode** (FRAMEWORK §5.4).
   - The designer sends it the definition. It renders with `createForm(definition, { mode: 'design' })` and `FormView`, and reports every component's box back.
   - Selection, handles, guides and drag feedback are drawn in an overlay outside the iframe, from those boxes, so nothing in the runtime knows about the designer.
   - Changes go to the canvas as a whole new definition. The runtime applies it in place: same components keep their state, and only new, removed or changed ones mount or update. This needs an `applyDefinition(next)` in core, beside today's `applyPatch`.
4. **Dragging changes position only** (FRAMEWORK §7).
   - A move never changes a component's parent or its place among its siblings. Re-parenting and reordering are explicit outline commands.
   - Dropping from the palette picks the parent under the pointer at the moment the component is created.
5. **Snap and nudge:** moves and resizes snap to an 8 px grid and to the edges of siblings, with guides drawn while dragging. Alt disables snapping. Arrow keys move the selection 1 px, and Shift+arrows move it 8 px. Each keyboard nudge is its own undo step, but a burst of nudges within half a second merges into one.
6. **Edges are kept:** moving or resizing keeps the layout's existing edges, so a component anchored by `right` and `bottom` stays anchored that way, and its numbers change instead.
7. **The inspector is generated from `ComponentMeta`:** a typed editor per prop kind (text, number, checkbox, choice, options list, JSON for anything else). Layout edges, `id`, events (handler names) and bindings (a picker of `dataset.column`, or a Dataset id for Dataset bindings) come from the form itself. `=` expressions stay editable as text, and `fw check`'s expression rules are shown as messages.
8. **Design reveal:** a closed Dialog and an unselected Tabs page are invisible, so the canvas can be told to show one for design. Selecting a component inside them reveals its page or dialog.
9. **Read-only:**
   - A file with merge conflicts or invalid JSON opens read-only. The designer shows why and how to fix it, and offers to open the text editor.
   - A file the designer can't safely edit is never written.
10. **The VS Code extension:**
    - `apps/vscode` is a `CustomTextEditorProvider` for `*.form.json`, offered as an alternative editor so the text editor stays available.
    - The webview runs the designer bundle under a strict content security policy.
    - Edits become one `WorkspaceEdit` per gesture.
    - It's packaged with `vsce` into a local `.vsix`, with no Marketplace.
    - Its tests run in the downloaded VS Code test copy in `.vscode-test/`.
11. **Preview** (stage B) runs the same form in run mode in a separate panel, with a fixture transport whose responses come from a `*.fixtures.json` beside the form, if there is one.
12. **Names in the UI** come from HTML, WAI-ARIA and these documents. The designer must not imitate the look of any commercial product's designer.

## Work packages, stage A

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | typescript-pro | `packages/core/**`, `packages/designer/src/model/**`, `packages/designer/test/model*` | `applyDefinition` and design reveal in core. The designer's model: parse the text, selection, commands that produce edits through `diffFormText`, snapping and edge-keeping maths, nudge merging, read-only state |
| 2 | react-specialist | `packages/designer/src/ui/**`, `packages/designer/src/canvas/**`, `packages/designer/test/ui*`, `packages/designer/dev/**` | The canvas page in the iframe, the overlay (select, move, resize, keyboard), the inspector, the read-only banner, the browser development host and page |
| 3 | tooling-engineer | `apps/vscode/**`, root `vscode:*` scripts | The VS Code extension, webview, edit mapping, packaging to `.vsix`, and extension tests in the VS Code test copy |

The contract between them is `packages/designer/src/contract.ts` (`DesignerHost` and the canvas messages). Changes to it are additive and reported.

## Work packages, stage B

Stage A is built: 1,322 unit tests and 12 extension tests pass, and the extension packages to a `.vsix`.

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | typescript-pro | `packages/core/**`, `packages/designer/src/model/**`, `packages/designer/test/model*` | Commands to add a component (parent chosen at drop, size and defaults from its meta), re-parent, reorder, and edit Datasets (columns and sample rows) and Grid columns (add, remove, width, field, format, editor, keeping header, record and footer rows placeable). Binding choices for the picker |
| 2 | react-specialist | `packages/designer/src/ui/**`, `src/canvas/**`, `src/preview/**`, `test/ui*`, `dev/**` | Palette with drag to add, outline panel, Dataset editor, Grid columns editor, binding picker, preview panel |
| 3 | tooling-engineer | `apps/vscode/**` | `readFixtures`, preview in VS Code, extension tests for the stage B flows, a rebuilt `.vsix` |

