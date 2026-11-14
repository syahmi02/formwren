import { createDesignerModel, type Command } from '../src/index.ts';
import { componentMetas } from '@fw/components/meta';
import { memoryHost } from './model-host.ts';

/** The lines that are in only one of two texts. A changed line counts as one removed and one added. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before.split('\n'));
  const b = count(after.split('\n'));
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i++) removed.push(line);
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i++) added.push(line);
  return { removed, added };
}

export function setup(text: string) {
  const host = memoryHost(text);
  const model = createDesignerModel(host, { metas: componentMetas });
  const run = async (command: Command) => {
    const before = host.text;
    const result = await model.apply(command);
    return { result, before, after: host.text, diff: changedLines(before, host.text) };
  };
  /** The result of a command that is expected to be refused, with the message. */
  const refused = async (command: Command): Promise<string> => {
    const before = host.text;
    const result = await model.apply(command);
    if (result.status !== 'rejected') throw new Error(`Expected a refusal, got ${result.status}`);
    if (host.text !== before) throw new Error('A refused command changed the text');
    return result.message;
  };
  const component = (id: string) => model.find(id)!;
  return { host, model, run, refused, component };
}
