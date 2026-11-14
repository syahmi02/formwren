import type { DsxRowError } from '@fw/core';

/** The request isn't valid DSX or breaks a limit: HTTP 400. */
export class BadRequestError extends Error {
  readonly code: string;
  constructor(message: string, code = 'bad-request') {
    super(message);
    this.name = 'BadRequestError';
    this.code = code;
  }
}

/** Rows were rejected: HTTP 422. A service can throw it to refuse a save. */
export class ValidationError extends Error {
  readonly rowErrors: readonly DsxRowError[];
  readonly code: string;
  constructor(rowErrors: readonly DsxRowError[], message?: string, code = 'invalid') {
    super(message ?? rejectedMessage(rowErrors));
    this.name = 'ValidationError';
    this.rowErrors = rowErrors;
    this.code = code;
  }
}

/** Someone else changed or deleted a row: HTTP 409, and the transaction rolls back. */
export class ConflictError extends Error {
  readonly rowErrors: readonly DsxRowError[];
  constructor(rowErrors: readonly DsxRowError[], message = 'Changed by someone else') {
    super(message);
    this.name = 'ConflictError';
    this.rowErrors = rowErrors;
  }
}

export function rejectedMessage(rowErrors: readonly DsxRowError[]): string {
  const rows = new Set(rowErrors.map((e) => `${e.dataset ?? ''}/${e.id ?? ''}`)).size;
  return `${rows} ${rows === 1 ? 'row was' : 'rows were'} rejected`;
}

/** True for a SQLite constraint failure (unique, foreign key, not null, check). */
export function isConstraintError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === 19;
}
