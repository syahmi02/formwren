export * from './contract.ts';

import { ExpressionError, type CompiledExpression, type ExpressionScope } from './contract.ts';
import { evaluateNode } from './evaluate.ts';
import { collectPaths, parse } from './parse.ts';

/** True for a prop value that holds an expression, meaning a string starting with "=". */
export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=');
}

/** Parses an expression once, with no `eval`. Throws `ExpressionError` on bad syntax. */
export function compileExpression(text: string): CompiledExpression {
  if (typeof text !== 'string') throw new ExpressionError('An expression must be a string', String(text), 0);
  const root = parse(text);
  const paths = collectPaths(root);
  return {
    source: text,
    paths,
    evaluate: (scope: ExpressionScope) => evaluateNode(root, scope, text),
  };
}
