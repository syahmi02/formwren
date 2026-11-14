import { describe, expect, it } from 'vitest';
import { openFormText, printForm, validateForm } from '../src/index.ts';

const base = { formatVersion: 1, id: 'a.Lookup', components: [] };

function open(extra: Record<string, unknown>): unknown {
  const opened = openFormText(JSON.stringify({ ...base, ...extra }));
  if (opened.status !== 'ok') throw new Error(opened.message);
  return opened.value;
}

describe('form result', () => {
  it('is accepted like params', () => {
    const form = open({ result: { empNo: { type: 'string' }, empName: { type: 'string', default: '' } } });
    expect(validateForm(form as never, {})).toEqual([]);
  });

  it('rejects a result that is not a typed map', () => {
    const form = open({ result: { empNo: 'string' } });
    expect(validateForm(form as never, {}).some((d) => d.severity === 'error')).toBe(true);
  });

  it('checks a default against its type', () => {
    const form = open({ result: { count: { type: 'int', default: 'x' } } });
    const errors = validateForm(form as never, {}).filter((d) => d.severity === 'error');
    expect(errors.map((d) => d.path)).toEqual(['result.count.default']);
  });

  it('is written after params, with each entry on one line', () => {
    const form = open({
      id: 'a.Lookup',
      events: { init: 'onInit' },
      params: { search: { type: 'string' } },
      result: { empNo: { type: 'string' } },
    });
    const text = printForm(form as never);
    expect(text).toContain('"result": {');
    expect(text.indexOf('"params"')).toBeLessThan(text.indexOf('"result"'));
    expect(text.indexOf('"result"')).toBeLessThan(text.indexOf('"events"'));
    expect(text).toContain('"empNo": { "type": "string" }');
    expect(openFormText(text).status).toBe('ok');
  });
});
