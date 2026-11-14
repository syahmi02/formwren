# Step 7 plan: the publish checklist

Read [../FRAMEWORK.md](../FRAMEWORK.md) §10 and [../REQUIREMENTS.md](../REQUIREMENTS.md) N-6 to N-8.

**Done when:** a clean copy of the repository is ready to push as a public GitHub repository, and every item in FRAMEWORK §10 is done or decided by the owner. The push itself, and creating the GitHub repository, are the owner's to approve.

## State at the start (2026-11-15)

- Steps 1 to 6 are committed. `step-6-designer` holds everything, and `main` is still at step 2.
- `docs/research/` and `.claude/` are not tracked. They are in `.gitignore`.
- The only tracked file that names a commercial platform is `CLAUDE.md`.
- No tracked file holds a personal path or name. But every commit's author address is the owner's personal email, which a public history would show. So the fresh history needs another author address, for example GitHub's no-reply one.
- CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm e2e`, but not `pnpm e2e:designer` or `pnpm vscode:test`.

## Decisions

1. **The public copy is a separate, fresh repository.**
   - It's exported from the tracked files at one commit, in a new folder with one first commit. The working repository and its history stay as they are.
   - Nothing ignored is copied, so `docs/research/`, `.claude/`, `.vscode-test/`, `.vsix` files and the demo database stay out.
2. **Licence:** Apache-2.0, with a `NOTICE`. The `.vsix` bundles third-party code (React, React Aria and others), so it ships their licence texts.
3. **Name:** the owner picks it from checked candidates (FRAMEWORK §11).
   - A name must not suggest any commercial platform in this category.
   - It needs no collisions on GitHub, npm or the VS Code Marketplace, or with known products.
   - The internal package names (`@fw/*`) and the `fw` command stay, because nothing is published to npm. The name goes in the README, the extension's display name and the repository.

## Work packages

| WP | Agent | Owns | Delivers |
|---|---|---|---|
| 1 | license-engineer | `LICENSE`, `NOTICE`, `apps/vscode/THIRD_PARTY_NOTICES.md`, `docs/licenses.md` | Apache-2.0 licence and notice. A licence audit of every dependency, with the tool built into pnpm (`pnpm licenses list`), flagging anything not permissive. The third-party notices for what the `.vsix` bundles |
| 2 | documentation-engineer | `README.md`, `apps/vscode/README.md`, `docs/getting-started.md` | A README saying what this is, what works, how to run the demo, the designer and the tests, that it has no login and is not production-ready, and the clean-room rules in neutral words |
| 3 | security-auditor | Report only | Secret and personal-data scan of everything that will be published. A review of N-6: localhost by default, parameterized SQL, no `eval`, data shown as text, the webview's content security policy, and the preview's script running |
| 4 | competitive-analyst | Report only | 8 to 10 name candidates, each checked for collisions |
| 5 | build-engineer | `.github/**`, root scripts | CI that also runs the designer browser tests and the extension tests, and works on Linux. A script that exports the fresh public copy into a folder given to it, without pushing anything |

The lead rewrites `CLAUDE.md` in neutral words, merges the results, and asks the owner about the name, the author address and the push.
