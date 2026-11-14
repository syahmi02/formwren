import type { Node } from 'jsonc-parser';
import { contentKey, deepEqual, hasOwn, isEmptyContainer, isObject, toJsonValue, type JsonObject, type JsonValue } from './json.ts';
import { childRole, elementRole, keyRank, orderedKeys, printInline, printValue, type Role } from './print.ts';
import { openFormText } from './text.ts';

/** Replace `length` characters at `offset` with `newText`. */
export interface TextEdit {
  offset: number;
  length: number;
  newText: string;
}

/** Thrown instead of writing to a file that isn't safe to change. */
export class FormTextError extends Error {
  readonly status: 'conflict' | 'invalid';

  constructor(status: 'conflict' | 'invalid', message: string) {
    super(message);
    this.name = 'FormTextError';
    this.status = status;
  }
}

interface Context {
  text: string;
  eol: string;
  edits: TextEdit[];
}

/** One property or array element in the existing text. */
interface Item {
  start: number;
  end: number;
  index: number;
}

/** A place in the new sequence: either an existing item, left where it is, or new text. */
type PlanEntry = { item: Item; rank: number } | { text: string; rank: number };

function indentOfLine(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  let end = lineStart;
  while (text[end] === ' ' || text[end] === '\t') end++;
  return text.slice(lineStart, end);
}

function isOneLine(context: Context, node: Node): boolean {
  return !context.text.slice(node.offset, node.offset + node.length).includes('\n');
}

/** How items in this container are separated, so new ones match what's already there. */
function separatorOf(context: Context, container: Node, items: readonly Item[]): { separator: string; indent: string | null } {
  const { text, eol } = context;
  const gaps = items.slice(1).map((item, i) => text.slice((items[i] as Item).end, item.start));
  gaps.unshift(text.slice(container.offset + 1, (items[0] as Item).start));
  for (const gap of gaps.reverse()) {
    const newline = gap.lastIndexOf('\n');
    if (newline !== -1) {
      const indent = gap.slice(newline + 1);
      return { separator: `,${eol}${indent}`, indent };
    }
  }
  return { separator: ', ', indent: null };
}

/** Records a replacement, trimmed to the characters that really differ. */
function pushEdit(context: Context, offset: number, oldText: string, newText: string): void {
  if (oldText === newText) return;
  let prefix = 0;
  const shorter = Math.min(oldText.length, newText.length);
  while (prefix < shorter && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  context.edits.push({
    offset: offset + prefix,
    length: oldText.length - prefix - suffix,
    newText: newText.slice(prefix, newText.length - suffix),
  });
}

/**
 * Turns the old sequence of items into the new one by rewriting only the gaps between items that
 * stay. Kept items, and the original spacing around unaffected items, aren't touched.
 */
function applyPlan(context: Context, items: readonly Item[], plan: readonly PlanEntry[], separator: string): void {
  const { text } = context;
  const firstStart = (items[0] as Item).start;
  const lastEnd = (items[items.length - 1] as Item).end;
  let previous: Item | null = null;
  let pending: string[] = [];

  for (const entry of plan) {
    if ('text' in entry) {
      pending.push(entry.text);
      continue;
    }
    const removedBetween = entry.item.index !== (previous ? previous.index + 1 : 0);
    if (pending.length > 0 || removedBetween) {
      const start: number = previous ? previous.end : firstStart;
      const newGap = (previous ? separator : '') + pending.map((added) => added + separator).join('');
      pushEdit(context, start, text.slice(start, entry.item.start), newGap);
    }
    previous = entry.item;
    pending = [];
  }

  const start = previous ? previous.end : firstStart;
  const hasBefore = previous !== null;
  const tail = pending.map((added, i) => (hasBefore || i > 0 ? separator : '') + added).join('');
  pushEdit(context, start, text.slice(start, lastEnd), tail);
}

function diffNode(context: Context, node: Node, oldValue: JsonValue, newValue: JsonValue, role: Role, oneLine: boolean): void {
  if (deepEqual(oldValue, newValue)) return;
  if (!isEmptyContainer(oldValue) && !isEmptyContainer(newValue)) {
    if (isObject(oldValue) && isObject(newValue)) {
      diffObject(context, node, oldValue, newValue, role);
      return;
    }
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      diffArray(context, node, oldValue, newValue, role);
      return;
    }
  }
  const newText = oneLine
    ? printInline(newValue, role)
    : printValue(newValue, role, indentOfLine(context.text, node.offset), context.eol);
  context.edits.push({ offset: node.offset, length: node.length, newText });
}

function diffObject(context: Context, node: Node, oldValue: JsonObject, newValue: JsonObject, role: Role): void {
  const properties = node.children as Node[];
  const items: (Item & { key: string; keyNode: Node; valueNode: Node })[] = properties.map((property, index) => {
    const [keyNode, valueNode] = property.children as [Node, Node];
    return {
      start: property.offset,
      end: valueNode.offset + valueNode.length,
      index,
      key: keyNode.value as string,
      keyNode,
      valueNode,
    };
  });
  const oneLine = isOneLine(context, node);
  const { separator, indent } = separatorOf(context, node, items);

  // A key renamed in place (same position, same rank) is rewritten where it stands, so the order of
  // the keys and the rest of the line stay as they were.
  const oldKeys = items.map((item) => item.key);
  const newKeys = Object.keys(newValue);
  const removed = oldKeys.filter((key) => !hasOwn(newValue, key));
  const added = newKeys.filter((key) => !hasOwn(oldValue, key));
  const renames = new Map<string, string>();
  if (removed.length === added.length) {
    removed.forEach((from, i) => {
      const to = added[i] as string;
      if (keyRank(role, from) === keyRank(role, to) && oldKeys.indexOf(from) === newKeys.indexOf(to)) renames.set(from, to);
    });
  }
  const renamedTo = new Set(renames.values());

  const plan: PlanEntry[] = [];
  for (const item of items) {
    const target = renames.get(item.key) ?? item.key;
    if (!hasOwn(newValue, target)) continue;
    if (target !== item.key) pushEdit(context, item.keyNode.offset, context.text.slice(item.keyNode.offset, item.keyNode.offset + item.keyNode.length), JSON.stringify(target));
    diffNode(
      context,
      item.valueNode,
      oldValue[item.key] as JsonValue,
      newValue[target] as JsonValue,
      childRole(role, target, newValue),
      oneLine,
    );
    plan.push({ item, rank: keyRank(role, target) });
  }

  for (const key of orderedKeys(newValue, role)) {
    if (hasOwn(oldValue, key) || renamedTo.has(key)) continue;
    const value = newValue[key] as JsonValue;
    const valueRole = childRole(role, key, newValue);
    const printed = indent === null ? printInline(value, valueRole) : printValue(value, valueRole, indent, context.eol);
    const rank = keyRank(role, key);
    const entry = { text: `${JSON.stringify(key)}: ${printed}`, rank };
    const before = plan.findIndex((planned) => planned.rank > rank);
    plan.splice(before === -1 ? plan.length : before, 0, entry);
  }

  applyPlan(context, items, plan, separator);
}

/** Unique ids if every element has one, which lets elements be matched across a change. */
function idsOf(array: readonly JsonValue[]): string[] | null {
  const ids = array.map((item) => (isObject(item) && typeof item.id === 'string' ? item.id : null));
  if (ids.includes(null) || new Set(ids).size !== ids.length) return null;
  return ids as string[];
}

/** Longest common subsequence, as a map from new index to old index. */
function matchSequences(oldKeys: readonly string[], newKeys: readonly string[]): Map<number, number> {
  const rows = oldKeys.length + 1;
  const columns = newKeys.length + 1;
  const lengths = new Uint32Array(rows * columns);
  for (let i = oldKeys.length - 1; i >= 0; i--) {
    for (let j = newKeys.length - 1; j >= 0; j--) {
      lengths[i * columns + j] =
        oldKeys[i] === newKeys[j]
          ? (lengths[(i + 1) * columns + j + 1] as number) + 1
          : Math.max(lengths[(i + 1) * columns + j] as number, lengths[i * columns + j + 1] as number);
    }
  }
  const matches = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < oldKeys.length && j < newKeys.length) {
    if (oldKeys[i] === newKeys[j]) {
      matches.set(j, i);
      i++;
      j++;
    } else if ((lengths[(i + 1) * columns + j] as number) >= (lengths[i * columns + j + 1] as number)) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/**
 * Between two matched elements, pairs the leftover old and new elements by position. A renamed
 * id then changes in place, keeping the element's formatting and key order, instead of being
 * removed and printed again. Order is kept, so a pair never crosses a match.
 */
function pairUnmatched(matches: Map<number, number>, oldLength: number, newLength: number): void {
  const anchors = [...matches.entries()].sort((a, b) => a[0] - b[0]);
  anchors.push([newLength, oldLength]);
  let previousNew = -1;
  let previousOld = -1;
  for (const [newIndex, oldIndex] of anchors) {
    const count = Math.min(newIndex - previousNew - 1, oldIndex - previousOld - 1);
    for (let k = 1; k <= count; k++) matches.set(previousNew + k, previousOld + k);
    previousNew = newIndex;
    previousOld = oldIndex;
  }
}

function diffArray(context: Context, node: Node, oldValue: JsonValue[], newValue: JsonValue[], role: Role): void {
  const elements = node.children as Node[];
  const itemRole = elementRole(role);
  const oneLine = isOneLine(context, node);
  const oldIds = idsOf(oldValue);
  const newIds = idsOf(newValue);

  if (!(oldIds && newIds) && oldValue.length === newValue.length) {
    oldValue.forEach((item, i) => {
      diffNode(context, elements[i] as Node, item, newValue[i] as JsonValue, itemRole, oneLine);
    });
    return;
  }

  const matches =
    oldIds && newIds
      ? matchSequences(oldIds, newIds)
      : matchSequences(oldValue.map(contentKey), newValue.map(contentKey));
  pairUnmatched(matches, oldValue.length, newValue.length);
  const items: Item[] = elements.map((element, index) => ({
    start: element.offset,
    end: element.offset + element.length,
    index,
  }));
  const { separator, indent } = separatorOf(context, node, items);

  const plan: PlanEntry[] = newValue.map((item, i) => {
    const oldIndex = matches.get(i);
    if (oldIndex !== undefined) {
      diffNode(context, elements[oldIndex] as Node, oldValue[oldIndex] as JsonValue, item, itemRole, oneLine);
      return { item: items[oldIndex] as Item, rank: i };
    }
    const text = indent === null ? printInline(item, itemRole) : printValue(item, itemRole, indent, context.eol);
    return { text, rank: i };
  });
  applyPlan(context, items, plan, separator);
}

export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(text.slice(cursor, edit.offset), edit.newText);
    cursor = edit.offset + edit.length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * The smallest text edits that turn `text` into a file holding `next`, in file order.
 *
 * Only parts that changed are touched, so hand formatting, key order and unknown keys elsewhere
 * in the file all survive, and no change gives no edits. A file with conflict markers or invalid
 * JSON throws `FormTextError`, so it can never be overwritten.
 */
export function diffFormText(text: string, next: unknown): TextEdit[] {
  const opened = openFormText(text);
  if (opened.status !== 'ok') throw new FormTextError(opened.status, opened.message);
  const target = toJsonValue(next, 'form');
  if (!isObject(target)) throw new TypeError('A form must be an object');

  const context: Context = { text, eol: text.includes('\r\n') ? '\r\n' : '\n', edits: [] };
  diffNode(context, opened.root, opened.value, target, 'form', false);
  const edits = context.edits.sort((a, b) => a.offset - b.offset);

  // Check the result before anyone writes it. A bug here must never damage a form file.
  if (edits.length > 0) {
    const result = openFormText(applyTextEdits(text, edits));
    if (result.status !== 'ok' || !deepEqual(result.value, target)) {
      throw new Error('Internal error: the form writer produced text that does not match the form. Nothing was written.');
    }
  }
  return edits;
}

/** The new text of a form file. See `diffFormText`. */
export function writeFormText(text: string, next: unknown): string {
  return applyTextEdits(text, diffFormText(text, next));
}
