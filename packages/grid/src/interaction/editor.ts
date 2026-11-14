import type { OptionItem } from '@fw/core';

export type EditorKind = 'text' | 'number' | 'dropdown' | 'date';

export interface EditorDom {
  /** The box placed in the overlay. */
  el: HTMLElement;
  control: HTMLInputElement | HTMLSelectElement;
  message: HTMLElement;
  /** What the control held before any typed character replaced it, after the browser cleaned it up. */
  initial: string;
}

export interface EditorSpec {
  kind: EditorKind;
  label: string;
  /** The cell's current value as text. */
  text: string;
  /** A character typed to open the editor, which replaces the text. */
  typed?: string;
  options?: readonly OptionItem[];
}

let counter = 0;

export function buildEditor(doc: Document, spec: EditorSpec): EditorDom {
  const el = doc.createElement('div');
  el.className = 'fw-grid__editor';
  el.dataset.editor = spec.kind;
  el.style.position = 'absolute';

  let control: HTMLInputElement | HTMLSelectElement;
  let initial = '';
  if (spec.kind === 'dropdown') {
    const select = doc.createElement('select');
    const items: OptionItem[] = [{ value: '', label: '' }, ...(spec.options ?? [])];
    if (spec.text !== '' && !items.some((item) => String(item.value ?? '') === spec.text)) {
      items.push({ value: spec.text, label: spec.text });
    }
    for (const item of items) {
      const option = doc.createElement('option');
      option.value = String(item.value ?? '');
      option.textContent = item.label;
      select.append(option);
    }
    select.value = spec.text;
    initial = select.value;
    if (spec.typed !== undefined) {
      const typed = spec.typed.toLowerCase();
      const match = items.find((item) => item.label !== '' && item.label.toLowerCase().startsWith(typed));
      if (match) select.value = String(match.value ?? '');
    }
    control = select;
  } else {
    const input = doc.createElement('input');
    input.type = spec.kind === 'date' ? 'date' : 'text';
    if (spec.kind === 'number') input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.value = spec.text;
    initial = input.value;
    if (spec.typed !== undefined && spec.kind !== 'date') input.value = spec.typed;
    control = input;
  }
  control.className = 'fw-grid__editor-control';
  control.setAttribute('aria-label', spec.label);

  const message = doc.createElement('span');
  message.className = 'fw-grid__editor-message';
  message.id = `fw-grid-editor-message-${++counter}`;
  message.hidden = true;

  el.append(control, message);
  return { el, control, message, initial };
}

/** Puts the caret at the end of a text editor, without throwing on inputs that can't hold one. */
export function caretToEnd(control: HTMLInputElement | HTMLSelectElement): void {
  if (control instanceof HTMLInputElement && control.type === 'text') {
    const end = control.value.length;
    control.setSelectionRange(end, end);
  }
}

export function placeEditor(dom: EditorDom, rect: { left: number; top: number; width: number; height: number }): void {
  const style = dom.el.style;
  style.left = `${rect.left}px`;
  style.top = `${rect.top}px`;
  style.width = `${rect.width}px`;
  style.height = `${rect.height}px`;
}

/** The message is a role="alert", so it is announced when it appears and no standing live region is needed. */
export function setInvalid(dom: EditorDom, message: string | null): void {
  if (message === null) {
    delete dom.el.dataset.invalid;
    dom.control.removeAttribute('aria-invalid');
    dom.control.removeAttribute('aria-describedby');
    dom.message.hidden = true;
    dom.message.removeAttribute('role');
    dom.message.textContent = '';
    return;
  }
  dom.el.dataset.invalid = 'true';
  dom.control.setAttribute('aria-invalid', 'true');
  dom.control.setAttribute('aria-describedby', dom.message.id);
  dom.message.textContent = message;
  dom.message.setAttribute('role', 'alert');
  dom.message.hidden = false;
}

export function setBusy(dom: EditorDom, busy: boolean): void {
  if (busy) {
    dom.el.dataset.busy = 'true';
    dom.el.setAttribute('aria-busy', 'true');
  } else {
    delete dom.el.dataset.busy;
    dom.el.removeAttribute('aria-busy');
  }
  if (dom.control instanceof HTMLInputElement) dom.control.readOnly = busy;
  else dom.control.disabled = busy;
}

/** True while a date input holds a partly typed date, which reads as "" but isn't empty. */
export function hasBadInput(dom: EditorDom): boolean {
  return dom.control instanceof HTMLInputElement && dom.control.validity.badInput;
}

export function readText(dom: EditorDom): string {
  return dom.control.value;
}
