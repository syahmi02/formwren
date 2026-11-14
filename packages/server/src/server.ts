import type { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isDecimal, type CellValue, type DsxColumn, type DsxResponse, type DsxResponseDataset, type DsxRowError } from '@fw/core';
import { BadRequestError, ConflictError, ValidationError, isConstraintError, rejectedMessage } from './errors.ts';
import { isUnchanged, saveChanges } from './persist.ts';
import { checkEnvelope, parseInputs, validateInputs } from './request.ts';
import {
  DEFAULT_LIMITS,
  type Applied,
  type Authorize,
  type ColumnDecl,
  type Limits,
  type ServerLogger,
  type Service,
  type ServiceContext,
  type ServiceResult,
} from './types.ts';

export interface ServerOptions {
  services: readonly Service[];
  db: DatabaseSync;
  /** Called after the service is found and the request is well formed. Return false to refuse (HTTP 403). Allows everything by default. */
  authorize?: Authorize;
  /** Receives server-side error details. Responses never carry them. Defaults to one JSON line on stderr. */
  logger?: ServerLogger;
  limits?: Partial<Limits>;
  /**
   * Host names the server answers to, without port. Anything else gets 400, so a web page can't reach the server
   * through a DNS name that points at 127.0.0.1. Defaults to 127.0.0.1, localhost and [::1].
   */
  hosts?: readonly string[];
}

const defaultLogger: ServerLogger = {
  error(details, message) {
    process.stderr.write(`${JSON.stringify({ level: 'error', message, ...details })}\n`);
  },
};

const MAX_ROW_ERRORS = 100;
const DEFAULT_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** The host name of a Host header, lower case, without the port. */
function hostName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(:\d{1,5})?$/i.exec(header.trim());
  return match?.[1]?.toLowerCase();
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
    return { error: error.message, name: error.name, stack: error.stack, code: extra.code, errcode: extra.errcode, errstr: extra.errstr };
  }
  return { error: String(error) };
}

function column(decl: ColumnDecl): DsxColumn {
  const out: DsxColumn = { id: decl.id, type: decl.type };
  if (decl.size !== undefined) out.size = decl.size;
  if (decl.precision !== undefined) out.precision = decl.precision;
  if (decl.scale !== undefined) out.scale = decl.scale;
  if (decl.key) out.key = true;
  if (decl.version) out.version = true;
  return out;
}

/** One value of an output row as it goes on the wire. Anything that would lose exactness is a server bug, so it throws. */
function outValue(decl: ColumnDecl, value: unknown, where: string): CellValue {
  if (value === null || value === undefined) return null;
  const fail = (): never => {
    throw new TypeError(`${where}: a ${typeof value} can't be sent as ${decl.type}`);
  };
  switch (decl.type) {
    case 'string':
    case 'date':
    case 'datetime':
      return typeof value === 'string' ? value : fail();
    case 'decimal':
      return typeof value === 'string' && isDecimal(value) ? value : fail();
    case 'int': {
      const n = typeof value === 'bigint' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || (typeof value === 'bigint' && BigInt(n) !== value)) return fail();
      return n;
    }
    case 'float':
      return typeof value === 'number' && Number.isFinite(value) ? value : fail();
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return value === 0 || value === 1 || value === 0n || value === 1n ? Number(value) === 1 : fail();
  }
}

function serializeOutputs(service: Service, result: ServiceResult): Record<string, DsxResponseDataset> | undefined {
  const out: Record<string, DsxResponseDataset> = {};
  for (const [name, rows] of Object.entries(result.datasets ?? {})) {
    const decl = Object.hasOwn(service.outputs, name) ? service.outputs[name] : undefined;
    if (!decl) throw new TypeError(`${service.id} returned a dataset "${name}" that it doesn't declare`);
    out[name] = {
      columns: decl.columns.map(column),
      rows: rows.map((row, r) => decl.columns.map((c) => outValue(c, row[c.id], `${service.id} ${name} row ${r} column ${c.id}`))),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function nonEmpty<T extends object>(value: T | undefined): T | undefined {
  return value !== undefined && Object.keys(value).length > 0 ? value : undefined;
}

/** Runs the handler in one BEGIN IMMEDIATE transaction. Any throw rolls everything back. */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }
}

/** A Fastify server with `POST /dsx/v1/tx/:serviceId`. The caller starts it with `listen` and closes the database itself. */
export function createServer(options: ServerOptions): FastifyInstance {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const logger = options.logger ?? defaultLogger;
  const registry = new Map<string, Service>();
  for (const service of options.services) {
    if (registry.has(service.id)) throw new Error(`Service ${service.id} is registered twice`);
    registry.set(service.id, service);
  }
  const { db } = options;

  const hosts = new Set((options.hosts ?? DEFAULT_HOSTS).map((h) => h.toLowerCase()));
  const app = Fastify({ logger: false, bodyLimit: limits.bodyBytes });

  const reply4xx = (reply: FastifyReply, http: number, code: string, message: string, errors?: readonly DsxRowError[]): FastifyReply => {
    const body: DsxResponse = { status: { ok: false, code, message } };
    if (errors && errors.length > 0) body.errors = errors.slice(0, MAX_ROW_ERRORS);
    return reply.code(http).send(body);
  };
  const internal = (reply: FastifyReply, error: unknown, context: Record<string, unknown>): FastifyReply => {
    try {
      logger.error({ ...context, ...describe(error) }, 'DSX request failed');
    } catch {
      // A broken logger must not turn into a different response.
    }
    return reply4xx(reply, 500, 'internal', 'The server could not complete the request');
  };

  app.addHook('onRequest', async (request, reply) => {
    const host = hostName(request.headers.host);
    if (host === undefined || !hosts.has(host)) return reply4xx(reply, 400, 'bad-request', 'This host name is not accepted');
    return undefined;
  });

  // Anything Fastify rejects itself (bad JSON, wrong content type, too large) is a bad request, with no detail of its own.
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const tooLarge = (error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE';
      const notJson = (error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY' || status === 415;
      return reply4xx(reply, 400, tooLarge ? 'limit' : 'bad-request', tooLarge ? 'The request is too large' : notJson ? 'The body is not JSON' : 'The request is not valid');
    }
    return internal(reply, error, {});
  });
  app.setNotFoundHandler((_request, reply) => reply4xx(reply, 404, 'not-found', 'Not found'));

  app.post('/dsx/v1/tx/:serviceId', async (request: FastifyRequest<{ Params: { serviceId: string } }>, reply) => {
    const serviceId = request.params.serviceId;
    const service = registry.get(serviceId);
    if (!service) return reply4xx(reply, 404, 'unknown-service', 'There is no such service');
    const context = { service: serviceId };

    let txId = '';
    try {
      const envelope = checkEnvelope(request.body, serviceId, limits);
      txId = envelope.txId;

      if (options.authorize && !(await options.authorize(request, { id: serviceId }))) {
        return reply4xx(reply, 403, 'forbidden', 'Not allowed');
      }

      const inputs = parseInputs(service, envelope);
      const validated = validateInputs(service, inputs);
      if (validated.count > 0) {
        return reply4xx(reply, 422, 'invalid', rejectedMessage(validated.errors), validated.errors);
      }

      const applied: Applied = {};
      const failures: DsxRowError[] = [];
      const ctx: ServiceContext = {
        db,
        txId,
        serviceId,
        params: envelope.params,
        request,
        applied,
        input(name) {
          if (!Object.hasOwn(service.inputs, name)) throw new Error(`${serviceId} has no input "${name}"`);
          return inputs.get(name) ?? { name, columns: [], kind: 'none', rows: [], changes: [] };
        },
        saveChanges(inputName, table, saveOptions) {
          return saveChanges(db, ctx.input(inputName), table, applied, failures, saveOptions);
        },
        isUnchanged(table, original) {
          return isUnchanged(db, table, original);
        },
      };

      // The whole response is built and turned into text before COMMIT, so anything that can't be sent rolls back.
      const body = inTransaction(db, () => {
        const result = service.run(ctx) ?? {};
        if (failures.length > 0) throw new ValidationError(failures, undefined, 'constraint');
        const response: DsxResponse = { status: { ok: true } };
        const params = nonEmpty(result.params);
        if (params) response.params = params;
        const datasets = serializeOutputs(service, result);
        if (datasets) response.datasets = datasets;
        const appliedOut = nonEmpty(applied);
        if (appliedOut) response.applied = appliedOut;
        return JSON.stringify(response);
      });
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error) {
      if (error instanceof BadRequestError) return reply4xx(reply, 400, error.code, error.message);
      if (error instanceof ConflictError) return reply4xx(reply, 409, 'conflict', error.message, error.rowErrors);
      if (error instanceof ValidationError) return reply4xx(reply, 422, error.code, error.message, error.rowErrors);
      if (isConstraintError(error)) {
        // Deferred constraints fail at COMMIT, when no single row can be blamed.
        try {
          logger.error({ ...context, txId, ...describe(error) }, 'Constraint failed');
        } catch {
          // Ignored: see above.
        }
        return reply4xx(reply, 422, 'constraint', 'The change breaks a rule of the data, such as a missing or still-used reference');
      }
      return internal(reply, error, { ...context, txId });
    }
  });

  return app;
}
