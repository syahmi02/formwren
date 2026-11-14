import { getNodeValue, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { toJsonValue, type JsonObject } from './json.ts';

export type OpenedForm =
  | { status: 'ok'; value: JsonObject; root: Node }
  /** The file has Git conflict markers. It must open read-only until someone resolves them. */
  | { status: 'conflict'; message: string }
  /** The file isn't valid strict JSON. It must also open read-only, so nothing overwrites it. */
  | { status: 'invalid'; message: string; line: number; column: number };

const CONFLICT_MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: |\r?$)/m;

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

function invalid(text: string, offset: number, message: string): OpenedForm {
  const { line, column } = position(text, offset);
  return { status: 'invalid', message: `Line ${line}, column ${column}: ${message}`, line, column };
}

function findBadKey(node: Node): { offset: number; message: string } | null {
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = (property.children as Node[])[0] as Node;
      const key = keyNode.value as string;
      if (key === '__proto__') return { offset: keyNode.offset, message: 'The key "__proto__" is not allowed' };
      if (seen.has(key)) {
        return { offset: keyNode.offset, message: `The key "${key}" appears twice, so one value would be lost` };
      }
      seen.add(key);
    }
  }
  for (const child of node.children ?? []) {
    const found = findBadKey(child);
    if (found) return found;
  }
  return null;
}

const NUMBER_LITERAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Sign, digits and a power of ten, so literals compare by value whatever their spelling. */
function normalizeNumber(text: string): string | null {
  const match = NUMBER_LITERAL.exec(text);
  if (!match) return null;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  const all = whole + fraction;
  const trimmed = all.replace(/0+$/, '');
  const power = Number(exponent) - fraction.length + (all.length - trimmed.length);
  const digits = trimmed.replace(/^0+/, '');
  return digits === '' ? '0' : `${sign}${digits}e${power}`;
}

/** True if the literal's exact value is the value of the double it parses to. */
function holdsExactly(literal: string): boolean {
  const normalized = normalizeNumber(literal);
  return normalized !== null && normalized === normalizeNumber(String(Number(literal)));
}

function findLossyNumber(node: Node, source: string): Node | null {
  if (node.type === 'number' && !holdsExactly(source.slice(node.offset, node.offset + node.length))) return node;
  for (const child of node.children ?? []) {
    const found = findLossyNumber(child, source);
    if (found) return found;
  }
  return null;
}

/** Reads a form file's text without judging its content. See `validateForm` for that. */
export function openFormText(text: string): OpenedForm {
  if (CONFLICT_MARKER.test(text)) {
    return { status: 'conflict', message: 'This file has Git conflict markers. Resolve them before editing it here.' };
  }
  // A byte order mark becomes a space while parsing, so offsets still match the real text.
  const source = text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text;
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
  const first = errors[0];
  if (first) return invalid(text, first.offset, printParseErrorCode(first.error));
  if (!root || root.type !== 'object') return invalid(text, root?.offset ?? 0, 'A form file must be a JSON object');
  const badKey = findBadKey(root);
  if (badKey) return invalid(text, badKey.offset, badKey.message);
  const lossy = findLossyNumber(root, source);
  if (lossy) {
    const literal = source.slice(lossy.offset, lossy.offset + lossy.length);
    return invalid(
      text,
      lossy.offset,
      `The number ${literal} can't be held exactly as a number, so it would change when saved. Write it as a string, such as "${literal}"`,
    );
  }
  try {
    return { status: 'ok', value: toJsonValue(getNodeValue(root), 'form') as JsonObject, root };
  } catch (error) {
    return invalid(text, 0, (error as Error).message);
  }
}
