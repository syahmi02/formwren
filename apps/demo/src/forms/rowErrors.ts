import type { DsxRowError } from '@fw/core';

/**
 * Server row errors name the Dataset by its wire name (`emp`) and may name no column, as a conflict does.
 * `form.showRowErrors` wants the form's own Dataset id and a column, so this adds both. `where` maps each wire
 * name to the form's Dataset id and the column to mark when the error names none.
 */
export function placeRowErrors(errors: readonly DsxRowError[], where: Record<string, { dataset: string; column: string }>): DsxRowError[] {
  const placed: DsxRowError[] = [];
  for (const error of errors) {
    const target = error.dataset === undefined ? undefined : where[error.dataset];
    if (target) placed.push({ ...error, dataset: target.dataset, column: error.column ?? target.column });
  }
  return placed;
}
