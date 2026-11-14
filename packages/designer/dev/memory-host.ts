import { applyTextEdits, type TextEdit } from '@fw/format';
import type { ApplyEditsOptions, DesignerHost } from '../src/contract.ts';

interface Step {
  before: string;
  after: string;
  label: string;
}

export interface MemoryHostOptions {
  fileName: string;
  text: string;
  readOnly?: boolean;
  /** The text of the fixtures file beside the form, if any. */
  fixtures?: string | null;
}

/**
 * A `DesignerHost` that keeps the file in memory, for development and browser tests. It has undo
 * and redo for the edit steps it was given, as VS Code does for a text file, and `setText` stands
 * in for typing in the text editor.
 */
export class MemoryHost implements DesignerHost {
  readonly fileName: string;
  readOnly: boolean;
  /** This host groups undo steps, so the designer merges a burst of nudges into one. */
  readonly canMergeEdits = true;
  private text: string;
  /** The fixtures file text. Tests and the page can change it. */
  fixtures: string | null;
  private readonly listeners = new Set<(text: string) => void>();
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  /** How often the text editor was asked for. For tests. */
  openedTextEditor = 0;
  /** Every label applied, in order. For tests. */
  readonly applied: string[] = [];

  constructor(options: MemoryHostOptions) {
    this.fileName = options.fileName;
    this.text = options.text;
    this.readOnly = options.readOnly ?? false;
    this.fixtures = options.fixtures ?? null;
  }

  readText = (): string => this.text;

  async applyEdits(edits: readonly TextEdit[], label: string, options?: ApplyEditsOptions): Promise<boolean> {
    if (this.readOnly) return false;
    const before = this.text;
    const after = applyTextEdits(before, edits);
    this.applied.push(label);
    const last = this.undoStack.at(-1);
    if (options?.mergeWithPrevious && last && last.after === before) last.after = after;
    else this.undoStack.push({ before, after, label });
    this.redoStack = [];
    this.set(after);
    return true;
  }

  onDidChangeText = (listener: (text: string) => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readFixtures = (): Promise<string | null> => Promise.resolve(this.fixtures);

  openTextEditor = (): void => {
    this.openedTextEditor++;
  };

  /** Replaces the text as typing in the text editor would. It is its own undo step. */
  setText(text: string): void {
    if (text === this.text) return;
    this.undoStack.push({ before: this.text, after: text, label: 'Edit text' });
    this.redoStack = [];
    this.set(text);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  undo(): void {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push(step);
    this.set(step.before);
  }

  redo(): void {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    this.set(step.after);
  }

  private set(text: string): void {
    this.text = text;
    for (const listener of [...this.listeners]) listener(text);
  }
}
