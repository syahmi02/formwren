/** The shared contract for `=` expressions. See docs/plans/step-2.md. */

export type AggregateName = 'sum' | 'avg' | 'min' | 'max' | 'count';

/**
 * Where an expression gets its values. Reads happen through this, inside a signal `computed`, so
 * whatever an expression reads is tracked automatically.
 */
export interface ExpressionScope {
  /** Reads a dotted path, such as ['vars', 'busy'] or ['ds', 'dsEmp', 'salary']. */
  read(path: readonly string[]): unknown;
  /** An aggregate over a column, such as sum(ds.dsEmp.salary), or sum(salary) in a Grid footer. */
  aggregate(name: AggregateName, path: readonly string[]): unknown;
}

export interface CompiledExpression {
  readonly source: string;
  /** Every path the expression reads, so `fw check` can validate them. */
  readonly paths: readonly (readonly string[])[];
  evaluate(scope: ExpressionScope): unknown;
}

export class ExpressionError extends Error {
  readonly source: string;
  /** Character position in the source, when known. */
  readonly position: number | undefined;

  constructor(message: string, source: string, position?: number) {
    super(message);
    this.name = 'ExpressionError';
    this.source = source;
    this.position = position;
  }
}
