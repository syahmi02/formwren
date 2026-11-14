import { decCompare, isDecimal } from '../decimal.ts';
import { ExpressionError } from './contract.ts';

export const MAX_SOURCE_LENGTH = 1000;
export const MAX_DEPTH = 64;

export type BinaryOp = '*' | '/' | '%' | '+' | '-' | '<' | '<=' | '>' | '>=' | '==' | '!=';
export type CallName = 'concat' | 'round' | 'div';
export type AggregateCallName = 'sum' | 'avg' | 'min' | 'max' | 'count';

export type Node =
  | { kind: 'literal'; value: string | number | boolean | null; pos: number }
  | { kind: 'path'; path: readonly string[]; pos: number }
  | { kind: 'unary'; op: '!' | '-'; operand: Node; pos: number }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node; pos: number }
  | { kind: 'logical'; op: '&&' | '||'; left: Node; right: Node; pos: number }
  | { kind: 'ternary'; test: Node; yes: Node; no: Node; pos: number }
  | { kind: 'call'; name: CallName; args: readonly Node[]; pos: number }
  | { kind: 'aggregate'; name: AggregateCallName; path: readonly string[]; pos: number };

type TokenType = 'number' | 'string' | 'ident' | 'op' | 'end';

interface Token {
  type: TokenType;
  text: string;
  value?: number | string;
  pos: number;
}

const AGGREGATES: ReadonlySet<string> = new Set(['sum', 'avg', 'min', 'max', 'count']);
const CALLS: ReadonlySet<string> = new Set(['concat', 'round', 'div']);

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 1; // skip the leading "="
  const fail = (message: string, pos: number): never => {
    throw new ExpressionError(message, source, pos);
  };

  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const start = i;

    if (isDigit(ch)) {
      while (isDigit(source.charAt(i))) i++;
      if (source.charAt(i) === '.' && isDigit(source.charAt(i + 1))) {
        i++;
        while (isDigit(source.charAt(i))) i++;
      }
      if (isIdentStart(source.charAt(i))) fail('A number can\'t be followed by a letter', i);
      const text = source.slice(start, i);
      // A literal a double can't hold exactly stays exact decimal text, so no digits are lost.
      const n = Number(text);
      const shown = String(n);
      const exact = isDecimal(shown) && decCompare(shown, text) === 0;
      tokens.push({ type: 'number', text, value: exact ? n : text, pos: start });
      continue;
    }

    if (isIdentStart(ch)) {
      while (isIdentStart(source.charAt(i)) || isDigit(source.charAt(i))) i++;
      tokens.push({ type: 'ident', text: source.slice(start, i), pos: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      i++;
      let text = '';
      for (;;) {
        if (i >= source.length) fail('Unterminated string', start);
        const c = source.charAt(i);
        if (c === ch) {
          i++;
          break;
        }
        if (c === '\\') {
          const next = source.charAt(i + 1);
          if (next === 'n') text += '\n';
          else if (next === 't') text += '\t';
          else if (next === '\\' || next === '"' || next === "'") text += next;
          else fail(`Unknown escape "\\${next}"`, i);
          i += 2;
          continue;
        }
        text += c;
        i++;
      }
      tokens.push({ type: 'string', text, value: text, pos: start });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', text: two, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/%<>!?:(),.'.includes(ch)) {
      tokens.push({ type: 'op', text: ch, pos: start });
      i++;
      continue;
    }
    if (ch === '=') fail('Use "==" to compare', i);
    if (ch === '&' || ch === '|') fail(`Use "${ch}${ch}"`, i);
    if (ch === '[') fail('Member access with [ ] is not supported', i);
    fail(`Unexpected character "${ch}"`, i);
  }
  tokens.push({ type: 'end', text: '', pos: source.length });
  return tokens;
}

export function parse(source: string): Node {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ExpressionError(`An expression can be at most ${MAX_SOURCE_LENGTH} characters`, source, MAX_SOURCE_LENGTH);
  }
  if (!source.startsWith('=')) throw new ExpressionError('An expression must start with "="', source, 0);

  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;

  const peek = (): Token => tokens[index] as Token;
  const fail = (message: string, token: Token = peek()): never => {
    throw new ExpressionError(message, source, token.pos);
  };
  const isOp = (text: string): boolean => peek().type === 'op' && peek().text === text;
  const accept = (text: string): Token | null => {
    if (!isOp(text)) return null;
    return tokens[index++] as Token;
  };
  const expect = (text: string): void => {
    if (!accept(text)) fail(`Expected "${text}"${peek().type === 'end' ? ' but the expression ended' : ''}`);
  };
  const enter = (): void => {
    if (++depth > MAX_DEPTH) fail(`Expression is nested more than ${MAX_DEPTH} levels deep`);
  };

  function ternary(): Node {
    enter();
    const test = or();
    const q = accept('?');
    let node = test;
    if (q) {
      const yes = ternary();
      expect(':');
      const no = ternary();
      node = { kind: 'ternary', test, yes, no, pos: q.pos };
    }
    depth--;
    return node;
  }

  function or(): Node {
    let left = and();
    for (let t = accept('||'); t; t = accept('||')) left = { kind: 'logical', op: '||', left, right: and(), pos: t.pos };
    return left;
  }

  function and(): Node {
    let left = equality();
    for (let t = accept('&&'); t; t = accept('&&')) left = { kind: 'logical', op: '&&', left, right: equality(), pos: t.pos };
    return left;
  }

  function binaryLevel(ops: readonly BinaryOp[], next: () => Node): Node {
    let left = next();
    for (;;) {
      const token = peek();
      const op = token.type === 'op' ? ops.find((o) => o === token.text) : undefined;
      if (!op) return left;
      index++;
      left = { kind: 'binary', op, left, right: next(), pos: token.pos };
    }
  }

  function equality(): Node {
    return binaryLevel(['==', '!='], relational);
  }
  function relational(): Node {
    return binaryLevel(['<', '<=', '>', '>='], additive);
  }
  function additive(): Node {
    return binaryLevel(['+', '-'], multiplicative);
  }
  function multiplicative(): Node {
    return binaryLevel(['*', '/', '%'], unary);
  }

  function unary(): Node {
    const token = peek();
    if (token.type === 'op' && (token.text === '!' || token.text === '-')) {
      index++;
      enter();
      const operand = unary();
      depth--;
      return { kind: 'unary', op: token.text, operand, pos: token.pos };
    }
    return primary();
  }

  function path(first: Token): string[] {
    const segments = [first.text];
    while (accept('.')) {
      const next = peek();
      if (next.type !== 'ident') fail('Expected a name after "."');
      index++;
      segments.push(next.text);
    }
    if (isOp('[')) fail('Member access with [ ] is not supported');
    return segments;
  }

  function primary(): Node {
    const token = peek();
    if (token.type === 'number') {
      index++;
      return { kind: 'literal', value: token.value as number | string, pos: token.pos };
    }
    if (token.type === 'string') {
      index++;
      return { kind: 'literal', value: token.value as string, pos: token.pos };
    }
    if (token.type === 'ident') {
      index++;
      if (isOp('(')) return call(token);
      if (token.text === 'true') return { kind: 'literal', value: true, pos: token.pos };
      if (token.text === 'false') return { kind: 'literal', value: false, pos: token.pos };
      if (token.text === 'null') return { kind: 'literal', value: null, pos: token.pos };
      return { kind: 'path', path: path(token), pos: token.pos };
    }
    if (accept('(')) {
      const inner = ternary();
      expect(')');
      return inner;
    }
    if (token.type === 'end') return fail('The expression ended unexpectedly');
    return fail(`Unexpected "${token.text}"`);
  }

  function call(name: Token): Node {
    expect('(');
    if (AGGREGATES.has(name.text)) {
      const arg = peek();
      if (arg.type !== 'ident') fail(`${name.text}() takes a column path, such as ds.dsEmp.salary`);
      index++;
      const segments = path(arg);
      expect(')');
      return { kind: 'aggregate', name: name.text as AggregateCallName, path: segments, pos: name.pos };
    }
    if (!CALLS.has(name.text)) {
      throw new ExpressionError(`Unknown function "${name.text}"`, source, name.pos);
    }
    const args: Node[] = [];
    if (!isOp(')')) {
      do args.push(ternary());
      while (accept(','));
    }
    expect(')');
    const fn = name.text as CallName;
    if (fn === 'concat' && args.length === 0) fail('concat() needs at least one argument', name);
    if (fn === 'round' && args.length !== 2) fail('round(value, scale) takes two arguments', name);
    if (fn === 'div' && args.length !== 3) fail('div(a, b, scale) takes three arguments', name);
    return { kind: 'call', name: fn, args, pos: name.pos };
  }

  const root = ternary();
  if (peek().type !== 'end') fail(`Unexpected "${peek().text}"`);
  return root;
}

/** Every path the expression reads, once each, in order of appearance. */
export function collectPaths(node: Node, out: Map<string, readonly string[]> = new Map()): readonly (readonly string[])[] {
  const add = (path: readonly string[]): void => {
    const key = path.join('.');
    if (!out.has(key)) out.set(key, path);
  };
  const walk = (n: Node): void => {
    switch (n.kind) {
      case 'path':
      case 'aggregate':
        add(n.path);
        break;
      case 'unary':
        walk(n.operand);
        break;
      case 'binary':
      case 'logical':
        walk(n.left);
        walk(n.right);
        break;
      case 'ternary':
        walk(n.test);
        walk(n.yes);
        walk(n.no);
        break;
      case 'call':
        n.args.forEach(walk);
        break;
      case 'literal':
        break;
    }
  };
  walk(node);
  return [...out.values()];
}
