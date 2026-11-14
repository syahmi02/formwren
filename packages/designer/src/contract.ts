/** The shared contract for the designer. See docs/plans/step-6.md. Changes must be additive and reported. */
import type { ComponentDefinition, FormDefinition } from '@fw/core';
import type { TextEdit } from '@fw/format';

/** Extra instructions for `DesignerHost.applyEdits`. Added in step 6, stage A. */
export interface ApplyEditsOptions {
  /**
   * Make this edit part of the previous undo step, so one undo takes back both. Only sent when the
   * host says `canMergeEdits`. The edits are always computed against the current text, so a host
   * that ignores this still ends up with the right text.
   */
  mergeWithPrevious?: boolean;
}

/**
 * Everything the designer needs from wherever it runs: VS Code, or a browser page for development
 * and tests. The text is the only source of truth (decision 1).
 */
export interface DesignerHost {
  /** The form file's name, for titles and messages. */
  readonly fileName: string;
  /** The current text of the form file. */
  readText(): string;
  /**
   * Applies text edits as one undoable step, labelled for the undo menu. Resolves false if the host
   * refused, for example because the text changed since it was read. The designer then re-reads.
   */
  applyEdits(edits: readonly TextEdit[], label: string, options?: ApplyEditsOptions): Promise<boolean>;
  /**
   * True if the host honours `ApplyEditsOptions.mergeWithPrevious`. Optional, so a host that can't
   * group undo steps just leaves it out, and the designer then makes one undo step per nudge.
   */
  readonly canMergeEdits?: boolean;
  /** Called after the text changes for any reason, including the designer's own edits. Returns an unsubscribe function. */
  onDidChangeText(listener: (text: string) => void): () => void;
  /** True if the host itself won't allow writing, for example a read-only file. */
  readonly readOnly: boolean;
  /** Opens the text editor for this file, at a character offset if given. Optional. */
  openTextEditor?(offset?: number): void;
  /**
   * The text of `<form name>.fixtures.json` beside the form, for the preview's fixture transport, or
   * null if there is none. Optional: without it, the preview runs with no transport. Added in stage B.
   */
  readFixtures?(): Promise<string | null>;
}

/** A component's box on the canvas, in canvas pixels, relative to the form's top-left corner. */
export interface ComponentBox {
  id: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Nesting depth, 0 for top-level components. Deeper boxes are on top for hit-testing. */
  depth: number;
  /** False while the component is on a hidden Tabs page or in a closed Dialog. */
  visible: boolean;
  /**
   * For a container, the area its children are placed in, in the same frame as `x` and `y`. A titled
   * Panel's children start below its title and border, so this differs from the outer box. Children's
   * layouts are relative to this box's top-left corner. Added after the step 6 review.
   */
  content?: { x: number; y: number; width: number; height: number };
}

/** Messages from the designer to the canvas iframe. */
export type ToCanvas =
  | { type: 'definition'; definition: FormDefinition }
  | { type: 'reveal'; id: string | null };

/** Messages from the canvas iframe to the designer. */
export type FromCanvas =
  | { type: 'ready' }
  | { type: 'boxes'; boxes: readonly ComponentBox[]; formWidth: number; formHeight: number }
  | { type: 'error'; message: string };

/** The minimal shape of a component the designer edits, for readers of this contract. */
export type DesignedComponent = ComponentDefinition;
