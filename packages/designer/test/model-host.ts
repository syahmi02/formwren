import { applyTextEdits, type TextEdit } from '@fw/format';
import type { ApplyEditsOptions, DesignerHost } from '../src/contract.ts';

export interface MemoryHost extends DesignerHost {
  text: string;
  readOnly: boolean;
  canMergeEdits: boolean;
  /** Every `applyEdits` call that reached the host. */
  readonly calls: { edits: readonly TextEdit[]; label: string; options: ApplyEditsOptions | undefined }[];
  /** Replaces the text from outside, as typing, undo or Git would. */
  setText(text: string): void;
  /** When true, the next `applyEdits` is refused. */
  refuseNext: boolean;
}

export function memoryHost(initial: string): MemoryHost {
  const listeners = new Set<(text: string) => void>();
  const host: MemoryHost = {
    fileName: 'test.form.json',
    text: initial,
    readOnly: false,
    canMergeEdits: true,
    calls: [],
    refuseNext: false,
    readText: () => host.text,
    async applyEdits(edits, label, options) {
      host.calls.push({ edits, label, options });
      if (host.refuseNext) {
        host.refuseNext = false;
        return false;
      }
      host.text = applyTextEdits(host.text, edits);
      for (const listener of [...listeners]) listener(host.text);
      return true;
    },
    onDidChangeText(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setText(text) {
      host.text = text;
      for (const listener of [...listeners]) listener(text);
    },
  };
  return host;
}

export const SAMPLE = `{
  "formatVersion": 1,
  "id": "demo.Form",
  "datasets": [
    {
      "id": "dsEmp",
      "columns": [{ "id": "name", "type": "string" }]
    }
  ],
  "components": [
    {
      "id": "title",
      "type": "Label",
      "layout": { "left": 16, "top": 16, "width": 200, "height": 24 },
      "props": { "text": "Employees" }
    },
    {
      "id": "box",
      "type": "Panel",
      "layout": { "right": 16, "bottom": 16, "width": 300, "height": 200 },
      "props": { "title": "Box" },
      "children": [
        {
          "id": "name",
          "type": "TextInput",
          "layout": { "left": 8, "top": 8, "right": 8, "height": 24 },
          "bind": { "value": "dsEmp.name" },
          "events": { "change": "onName" }
        },
        {
          "id": "go",
          "type": "Button",
          "layout": { "left": 8, "top": 40, "width": 80, "height": 24 },
          "props": { "text": "Go" }
        }
      ]
    },
    {
      "id": "other",
      "type": "Button",
      "layout": { "left": 400, "top": 16, "width": 80, "height": 24 },
      "props": { "text": "Other" }
    }
  ]
}
`;
