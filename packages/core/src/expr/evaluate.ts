import { decAdd, decCompare, decDiv, decMul, decRound, decSub, isDecimal } from '../decimal.ts';
import { ExpressionError, type ExpressionScope } from './contract.ts';
import type { Node } from './parse.ts';

type Ctx = { scope: ExpressionScope; source: string };

function fail(ctx: Ctx, message: string, pos: number): never {
  throw new ExpressionError(message, ctx.source, pos);
}

function isNullish(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isDecimalText(v: unknown): v is string {
  return typeof v === 'string' && isDecimal(v);
}

function describe(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/** A value as exact decimal text, or null if it isn't one. A number goes through String(n). */
function asDecimal(v: unknown): string | null {
  if (isDecimalText(v)) return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const text = String(v);
    return isDecimal(text) ? text : null;
  }
  return null;
}

function arithmetic(ctx: Ctx, op: '+' | '-' | '*', a: unknown, b: unknown, pos: number): unknown {
  if (isNullish(a) || isNullish(b)) return null;
  if (typeof a === 'number' && typeof b === 'number') {
    return op === '+' ? a + b : op === '-' ? a - b : a * b;
  }
  if (isDecimalText(a) || isDecimalText(b)) {
    const x = asDecimal(a);
    const y = asDecimal(b);
    if (x !== null && y !== null) return op === '+' ? decAdd(x, y) : op === '-' ? decSub(x, y) : decMul(x, y);
  }
  const hint = op === '+' ? ' Use concat() to join text.' : '';
  return fail(ctx, `Can't use "${op}" on ${describe(a)} and ${describe(b)}.${hint}`, pos);
}

function numbersOnly(ctx: Ctx, op: '/' | '%', a: unknown, b: unknown, pos: number): unknown {
  if (isNullish(a) || isNullish(b)) return null;
  if (typeof a !== 'number' || typeof b !== 'number') {
    const hint = op === '/' ? ' Use div(a, b, scale) for exact decimals.' : '';
    return fail(ctx, `"${op}" works on numbers only, not ${describe(a)} and ${describe(b)}.${hint}`, pos);
  }
  if (b === 0) return fail(ctx, op === '/' ? 'Division by zero' : 'Remainder of division by zero', pos);
  return op === '/' ? a / b : a % b;
}

function compare(ctx: Ctx, a: unknown, b: unknown, pos: number): number | null {
  if (isNullish(a) || isNullish(b)) return null;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') {
    if (isDecimal(a) && isDecimal(b)) return decCompare(a, b);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (isDecimalText(a) || isDecimalText(b)) {
    const x = asDecimal(a);
    const y = asDecimal(b);
    if (x !== null && y !== null) return decCompare(x, y);
  }
  return fail(ctx, `Can't compare ${describe(a)} with ${describe(b)}`, pos);
}

function scaleArg(ctx: Ctx, v: unknown, pos: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) {
    return fail(ctx, `The scale must be a whole number from 0 to 1000, not ${describe(v)}`, pos);
  }
  return v;
}

function decimalArg(ctx: Ctx, v: unknown, pos: number): string {
  const text = asDecimal(v);
  return text ?? fail(ctx, `${describe(v)} is not a decimal number`, pos);
}

function text(v: unknown): string {
  return isNullish(v) ? '' : String(v);
}

export function evaluateNode(node: Node, scope: ExpressionScope, source: string): unknown {
  const ctx: Ctx = { scope, source };
  return run(node, ctx);
}

function run(node: Node, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return ctx.scope.read(node.path);
    case 'aggregate':
      return ctx.scope.aggregate(node.name, node.path);
    case 'unary': {
      const v = run(node.operand, ctx);
      if (node.op === '!') return !v;
      if (isNullish(v)) return null;
      if (typeof v === 'number') return -v;
      if (isDecimalText(v)) return decSub('0', v);
      return fail(ctx, `Can't negate ${describe(v)}`, node.pos);
    }
    case 'logical': {
      const left = run(node.left, ctx);
      if (node.op === '&&') return left ? run(node.right, ctx) : left;
      return left ? left : run(node.right, ctx);
    }
    case 'ternary':
      return run(node.test, ctx) ? run(node.yes, ctx) : run(node.no, ctx);
    case 'binary': {
      const a = run(node.left, ctx);
      const b = run(node.right, ctx);
      switch (node.op) {
        case '+':
        case '-':
        case '*':
          return arithmetic(ctx, node.op, a, b, node.pos);
        case '/':
        case '%':
          return numbersOnly(ctx, node.op, a, b, node.pos);
        case '==':
          return a === b || (isNullish(a) && isNullish(b));
        case '!=':
          return !(a === b || (isNullish(a) && isNullish(b)));
        default: {
          const order = compare(ctx, a, b, node.pos);
          if (order === null) return false;
          return node.op === '<' ? order < 0 : node.op === '<=' ? order <= 0 : node.op === '>' ? order > 0 : order >= 0;
        }
      }
    }
    case 'call': {
      const args = node.args.map((arg) => run(arg, ctx));
      if (node.name === 'concat') return args.map(text).join('');
      if (node.name === 'round') {
        if (isNullish(args[0])) return null;
        return decRound(decimalArg(ctx, args[0], node.pos), scaleArg(ctx, args[1], node.pos));
      }
      if (isNullish(args[0]) || isNullish(args[1])) return null;
      const scale = scaleArg(ctx, args[2], node.pos);
      const divisor = decimalArg(ctx, args[1], node.pos);
      const dividend = decimalArg(ctx, args[0], node.pos);
      if (decCompare(divisor, '0') === 0) return fail(ctx, 'Division by zero', node.pos);
      return decDiv(dividend, divisor, scale);
    }
  }
}
