# Step 4 plan: transactions, server and SQLite

Read [../FRAMEWORK.md](../FRAMEWORK.md) §6 and §8 (P4), [../REQUIREMENTS.md](../REQUIREMENTS.md) §2 (D1, D2), §3.5 and §4 (N-1, N-2, N-3, N-6), and the rules at the top of [step-2.md](step-2.md), which still apply. The decisions in step-2.md and [step-3.md](step-3.md) still stand.

**Done when:** D1 and D2 work against a real SQLite database through the real server, started with one command from a clean clone. Every Must in §3.5 works, P4 passes, and N-2 and N-3 have integration tests on the real database.

**Agents are limited to the ones with the most impact:** three build, then `test-automator` and one reviewer.

## Decisions

1. **Stack:** Node 24 or later, Fastify 5, and Node's built-in `node:sqlite` (`DatabaseSync`), so there's no native module to build. One synchronous transaction per request, using `BEGIN IMMEDIATE`.
2. **Package:** `packages/server` (`@fw/server`) is the library: the DSX endpoint, service registry, `tableService`, `customService`, transactions, conflicts and error mapping. The demo's own services, schema and seed data live in `apps/demo/server/`.
3. **Endpoint and limits:**
   - `POST /dsx/v1/tx/:serviceId`, JSON only, listening on `127.0.0.1`.
   - Default port 5300.
   - A 5 MB body limit. Requests with more than 20 Datasets, 100 columns or 100,000 rows are rejected before any work.
4. **Wire format:** exactly FRAMEWORK §6.2 and the golden vectors in `packages/core/test/fixtures/dsx/`, which the server must pass as a conformance test. A difference between the server and the vectors is a bug in one of them, raised with the lead, never patched over quietly.
5. **Services:** a service declares its inputs and outputs, and for each its columns (id, type, size, precision, scale, required, key, version), so the server validates against its own declaration and never trusts the client's.
   - Unknown columns are rejected (400).
   - Every row is validated before any write (422, with row errors).
6. **`tableService`** generates parameterized SQL from a table declaration. Updates set only the columns in `o`. Deletes, then updates, then inserts within a Dataset, and declared order across Datasets. A key marked `generated` is assigned by the server and returned in `applied`. The version column is incremented on update and returned in `applied`.
7. **Conflicts:**
   - **The check:** a version column if declared, otherwise every loaded column, skipping floats. Originals come from `v` and `o`, as the client sent them.
   - **A conflict:** a zero-row update or delete. The whole transaction rolls back, and the response is HTTP 409 with `status.code` `conflict` and a row error per conflicting row.
8. **Exact values:**
   - Decimals, dates and datetimes are stored as `TEXT` and compared as exact text. The client never normalizes loaded text, so an unchanged value matches.
   - Empty string and null stay distinct.
   - Ints are `INTEGER`, read as numbers only when they're safe integers.
   - P4 proves all of this.
9. **Errors:** raw database messages and stack traces are never sent. Unknown service is 404. A body that isn't valid DSX is 400. Validation is 422. A conflict is 409. Anything else is 500 with a generic message, with the details logged on the server.
10. **Security:** an `authorize(request, service)` hook that allows everything by default. Parameterized SQL only, with table and column names coming only from service declarations, never from the request. No CORS: the demo's dev server proxies `/dsx` to the server.
11. **Client side:**
    - `httpTransport(baseUrl)` in core uses `fetch` with the abort signal.
    - It maps HTTP and network failures to `TransactionError` codes.
    - It never retries.
    - Columns can be declared `version: true` in form files, and the client sends that flag.
12. **One command:** from a clean clone, `pnpm install` then `pnpm demo` creates and seeds the database if it's missing, starts the server and the dev server, and prints the URL. `pnpm demo:reset` rebuilds the database. The database file is gitignored.
13. **Fixtures stay** for unit tests. The browser tests move to the real server, each run starting from a freshly seeded test database. The demo server can add a delay and fail on demand, as the fixtures did.

## Work packages and ownership

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | node-specialist | `packages/server/**`, `apps/demo/server/**` | The server library, the demo's services and seed data, conformance to the golden vectors, N-2 and N-3 integration tests |
| 2 | typescript-pro | `packages/core/**`, `packages/format/**` | `httpTransport`, the `version` column flag in the format and codec, new golden vectors for conflicts, HTTP statuses and P4 values |
| 3 | react-specialist | `apps/demo/src/**`, `apps/demo/vite.config.ts`, `apps/demo/scripts/**`, root `demo` scripts | The D2 master-detail screen, switching the demo to the real server, the one-command start |

The DSX contract is `packages/core/src/tx/contract.ts` plus the golden vectors. Changes to either go through `typescript-pro`, and are reported to the lead.
