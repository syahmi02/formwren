# Dependency licences

This is the licence audit of every third-party package installed in this workspace. The project itself is licensed under Apache-2.0 (see `LICENSE` and `NOTICE`).

## How this list was made

**This first version was not produced by `pnpm licenses list`.** The session that wrote it couldn't run shell commands. Instead, it read the `license` field in the `package.json` of every package installed under `node_modules/.pnpm`. That is the field `pnpm licenses list` reports.

- **Date and install:** 2026-11-15, the Windows x64 install.
- **Scope:** 386 third-party packages, plus the 10 workspace packages.
- **Not checked:** packages that only install on other platforms. On Linux, for example, `lightningcss` and `rolldown` pull in Linux binaries instead of the Windows ones listed here. Those binaries carry the same licence as their parent package.

**Confirmed with `pnpm licenses list --json` on 2026-11-15.** It reports 373 packages, because it groups versions of one package that this list counts separately. It flags the same packages: `@vscode/vsce-sign` (licence unknown to pnpm, Microsoft's terms), `lightningcss` (MPL-2.0) and `jszip` (MIT or GPL-3.0). The `--prod` list holds MIT, Apache-2.0, BSD-3-Clause, ISC and 0BSD packages, plus `lightningcss`, which comes in through Vite in `@fw/cli`.

Confirm or regenerate the list with pnpm's built-in tool:

```sh
pnpm licenses list --json         # every dependency, dev and test tools included
pnpm licenses list --prod --json  # only the dependencies of the workspace packages
pnpm licenses list --prod --json --filter @fw/components   # one workspace
```

The counts below should match the first command on the same platform. If they don't, update this file from the pnpm output.

## Summary

| Licence | Packages | Type |
|---|---:|---|
| MIT | 305 | permissive |
| Apache-2.0 | 29 | permissive |
| ISC | 17 | permissive |
| BSD-2-Clause | 10 | permissive |
| BSD-3-Clause | 9 | permissive |
| Artistic-2.0 | 5 | see below |
| BlueOak-1.0.0 | 4 | permissive |
| MPL-2.0 | 2 | weak copyleft, see below |
| SEE LICENSE IN LICENSE.txt (Microsoft proprietary) | 2 | proprietary, see below |
| 0BSD | 1 | permissive |
| (MIT AND Zlib) | 1 | permissive |
| (MIT OR GPL-3.0-or-later) | 1 | dual, MIT chosen, see below |
| **Total** | **386** | |

No installed package is GPL-only, LGPL, AGPL, EPL, SSPL or CC-BY-NC. None is UNLICENSED, and none is missing a `license` field.

All 10 workspace packages (the root, `@fw/*`, `demo` and `fw-designer`) are `"license": "Apache-2.0"` and `"private": true`.

## What ships

"Shipped" means code that is bundled into a file we hand to users:

- **The `.vsix`:** `dist/extension.cjs`, `dist/webview/designer.js` and `dist/webview/canvas.js`. The contents come from each bundle's sourcemap. They are 15 packages, listed with versions and copyright lines in [`apps/vscode/THIRD_PARTY_NOTICES.md`](../apps/vscode/THIRD_PARTY_NOTICES.md).
- **The browser runtime:** what `fw build` bundles for an app. Its third-party code comes from the `dependencies` of `@fw/core`, `@fw/grid`, `@fw/components` and `@fw/format`. Every package it can contain is in the same 15.

The 15 are:

- **MIT:** `react`, `react-dom`, `scheduler`, `use-sync-external-store`, `clsx`, `@preact/signals-core`, `@tanstack/virtual-core`, `jsonc-parser` and `@cfworker/json-schema`.
- **Apache-2.0:** `react-aria`, `react-aria-components`, `react-stately` and `@internationalized/date`, `number` and `string`.

`react-aria` and `@internationalized/date` also contain code derived from React, Microsoft Tabster, vue-test-utils and jest-dom (all MIT), from ICU (Unicode licence) and from the TC39 Temporal proposal (Ecma BSD licence). Their notices are in the notices file too.

**Nothing that ships is under a non-permissive licence.**

The minified bundles drop the licence comments of the source files, so `THIRD_PARTY_NOTICES.md` must be packaged into the `.vsix`. `apps/vscode/.vscodeignore` includes it.

The server (`@fw/server` with Fastify and its dependencies) is not bundled. It runs from `node_modules` on the user's own machine, and its dependency tree is all MIT, ISC, BSD-3-Clause and BlueOak-1.0.0.

## Packages that are not plainly permissive

| Package | Version | Licence | Pulled in by | Shipped? |
|---|---|---|---|---|
| `@vscode/vsce-sign` | 2.1.1 | Microsoft Software License Terms (`SEE LICENSE IN LICENSE.txt`) | `@vscode/vsce` | No. Dev tool for packaging the `.vsix` |
| `@vscode/vsce-sign-win32-x64` | 2.0.8 | Microsoft Software License Terms (`SEE LICENSE IN LICENSE.txt`) | `@vscode/vsce-sign` (platform binary) | No. Dev tool |
| `lightningcss` | 1.33.0 | MPL-2.0 | `vite` | No. Build tool. CSS it processes is not covered |
| `lightningcss-win32-x64-msvc` | 1.33.0 | MPL-2.0 | `lightningcss` (platform binary) | No. Build tool |
| `jszip` | 3.10.2 | (MIT OR GPL-3.0-or-later) | `@vscode/test-electron` | No. Test tool |
| `istextorbinary` | 9.5.0 | Artistic-2.0 | `@secretlint/source-creator`, from `@vscode/vsce` | No. Dev tool |
| `binaryextensions` | 6.11.0 | Artistic-2.0 | `istextorbinary` | No. Dev tool |
| `textextensions` | 6.11.0 | Artistic-2.0 | `istextorbinary` | No. Dev tool |
| `editions` | 6.22.0 | Artistic-2.0 | `istextorbinary`, `binaryextensions`, `textextensions` | No. Dev tool |
| `version-range` | 4.15.0 | Artistic-2.0 | `editions` | No. Dev tool |

**Notes on each:**

- **`@vscode/vsce-sign`** is proprietary. Its terms allow it to be installed and used only with Microsoft's Visual Studio products and services, which include VS Code, "to develop and test your applications". They forbid sharing or publishing it.
  - We only run it through `pnpm vscode:package`. That's within those terms, as long as it is never committed, vendored or redistributed.
  - `node_modules/` is in `.gitignore`.
- **`lightningcss`** is MPL-2.0, whose copyleft is per file. It applies only if we distribute lightningcss itself, modified or not. Running it as part of `vite build` puts no terms on the output. It is in the `--prod` tree only because `@fw/cli` lists `vite` as a dependency.
- **`jszip`** lets the user choose either licence. We take it under MIT. It is used only by the extension test runner.
- **Artistic-2.0** is an OSI-approved licence. Using a package unmodified, as these are used, has no conditions. The conditions apply only to distributing modified versions. These packages come in through `vsce`'s secret scanner.

## Keeping this current

- Re-run `pnpm licenses list --json` after any dependency change. Flag any new licence that isn't in the summary above.
- If the bundles gain a package, add it to `apps/vscode/THIRD_PARTY_NOTICES.md`. The bundles' sourcemaps list every source file under `node_modules/.pnpm/<package>@<version>/`.
