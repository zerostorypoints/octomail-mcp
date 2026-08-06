# Gmail MCP: Open-Source Release and Setup Wizard

**Date:** 2026-08-06
**Status:** Approved design, ready for implementation planning

## Problem

`gmail-mcp` is a working local MCP server exposing several Gmail accounts to Codex and Claude Code. It already sits in a public GitHub repo, but nothing about it is ready for strangers: no license, no repo description, a README that hardcodes `/Users/<user>/...` paths and personal account aliases, and setup instructions that cover Codex only.

It is also not fully working locally. Of the three configured aliases only `private` holds a token; `work` and `support` will error. The Codex config points at `Projects/gmail-mcp`, but the project moved to `Projects/_arch/gmail-mcp`, so Codex cannot launch the server at all.

Two goals, one pass: make the project presentable and distributable under the Zero Story Points org, and make onboarding an account a single verified command rather than a sequence of manual file edits.

## Current state

TypeScript compiled with `tsc`, Node >= 20, a stdio MCP server built on `@modelcontextprotocol/sdk` with `googleapis` and `zod`. 666 lines across four files:

| File | Role |
| --- | --- |
| `src/server.ts` | Tool definitions and the stdio transport |
| `src/gmail.ts` | OAuth client construction, Gmail helpers, MIME encoding |
| `src/config.ts` | Accounts config and OAuth credential resolution |
| `src/auth.ts` | Loopback OAuth authorization CLI |

Ten tools, deliberately excluding send, trash, and delete. Tokens live outside the repo at mode `0600`. Git history is clean: no real credential has ever been committed, so no history rewrite is needed.

## Constraints and decisions

| Decision | Choice |
| --- | --- |
| Release tier | Presentable public repo. No npm publish. |
| Distribution | Zero Story Points org; Piotr Dziubecki as author |
| Repo move | GitHub-transfer `<old-owner>/gmail-mcp` to `zerostorypoints/gmail-mcp`, preserving history and leaving a redirect |
| License | Apache-2.0, matching the org's existing public repo `symblon` |
| Package name | `@zerostorypoints/gmail-mcp` |
| Runtime MCP server name | Stays `gmail-multi-mcp`, so live registrations keep working |
| `"private": true` | Kept, as a guard against accidental publish |
| Personal vs Workspace accounts | No config difference. Divergence is documented, not coded. |

### Why Testing mode is a headline, not a footnote

A Google OAuth app whose publishing status is "Testing" with External user type issues refresh tokens that **expire after 7 days**. With four accounts that means re-authorizing all of them weekly. Moving the app to "In Production" yields non-expiring refresh tokens. Unverified apps in production show a warning screen the user clicks through and are capped at 100 users, which is irrelevant for personal use. The docs must lead with this, and the runtime must produce a readable error when it happens anyway.

## Architecture

### Module boundaries

The OAuth flow currently lives inside `auth.ts`'s `main()`, which makes it unreachable from a wizard. Extracting it is the enabling change for everything else.

| Module | Responsibility |
| --- | --- |
| `src/oauth.ts` (new) | `authorizeAccount(alias)`: loopback callback server, token exchange, profile lookup, token write at `0600`, config save |
| `src/config.ts` | Accounts file ownership: load, validate, save, resolve token paths, register new aliases |
| `src/auth.ts` | Thin CLI wrapper over `authorizeAccount` |
| `src/setup.ts` (new) | Interactive and flag-driven onboarding wizard |
| `src/doctor.ts` (new) | Non-interactive health check |
| `src/gmail.ts` | Gmail API helpers, plus error translation |
| `src/server.ts` | Tool definitions |

One OAuth flow, one place, two entry points.

### Config format

`tokenPath` becomes optional, defaulting to `<tokenDir>/<alias>.json` where `tokenDir` is `GMAIL_MCP_TOKEN_DIR` or `~/.gmail-multi-mcp/tokens`. Two new optional fields: `label` (free text, hand-written) and `email` (captured automatically at authorization time).

```json
{
  "accounts": {
    "work":     { "label": "Work (Workspace)", "email": "alice@example.com" },
    "personal": { "label": "Personal Gmail" },
    "support":  {}
  }
}
```

An explicit `tokenPath` still works, so existing files keep loading unchanged. The alias regex `^[a-zA-Z0-9_-]+$` continues to gate names.

New in `config.ts`:

- `saveAccountsConfig(config)` writes the file with 2-space JSON.
- `ensureAccount(alias)` loads the config, creates `accounts.json` as `{"accounts":{}}` if absent, adds the alias if missing, saves, and returns the resolved `AccountConfig`.

### Setup wizard

`npm run setup` runs five steps:

1. Verify Node >= 20 and report whether `dist/` is present and current.
2. Resolve OAuth credentials. If absent, print the Google Cloud walkthrough (including the In Production requirement), prompt for client ID and secret, and write `.env` at mode `0600`.
3. Loop over accounts: alias, optional label, browser authorization, email capture. Ask whether to add another.
4. Run the full `doctor` check against every configured account.
5. Print ready-to-paste MCP config for Claude Code and Codex with this checkout's absolute path filled in.

Step 5 is what prevents a recurrence of the stale-path breakage that exists today.

**TTY handling.** Interactive prompts require a TTY, and an agent-driven shell does not have one. The wizard checks `process.stdin.isTTY`; with no TTY and missing information it exits immediately, listing the flags to pass instead of hanging. Everything is drivable non-interactively as `npm run setup -- --account work --label "Work"`.

**Browser step.** Authorization inherently requires a human at a browser. The wizard prints the URL and attempts to open it, falling back to printing alone. The consent screen is always clicked through by the user.

### Doctor

`npm run doctor` is step 4 standalone and is always non-interactive. It checks Node version, build freshness (`dist/` newer than `src/`), OAuth credential resolution, and `accounts.json` parsing. Then per account it verifies the token file exists with mode `0600` and makes a live `users.getProfile` call:

```
✓ work      → alice@example.com
✗ support   — not authorized, run: npm run auth -- --account support
```

Every failure line carries the command that fixes it.

### Authorization visibility

`gmail_list_accounts` changes shape from `{accounts: ["a","b"]}` to:

```json
{ "accounts": [
    { "account": "work", "email": "alice@example.com", "label": "Work (Workspace)", "authorized": true },
    { "account": "support", "authorized": false }
] }
```

`authorized` reflects token file existence; `email` and `label` are read from config. No API calls at list time. Unauthorized accounts omit `email`. This is a breaking output change, acceptable because the repo has no other users.

### Error translation

`describeAccountError(account, error)` in `gmail.ts` maps Google's `invalid_grant` into a message naming the account, the exact re-auth command, and the Testing-mode expiry as a likely cause. It is called from `safeTool` (which gains an optional `account` parameter) and from the per-account error branch of `gmail_search_many`, so a dead token reads identically through either path.

### Dependency fix

`google-auth-library` is imported at `src/gmail.ts:3` but is not a declared dependency; it currently resolves only transitively through `googleapis` and would break on a dependency bump. It becomes explicit.

## Agent-native onboarding

`.claude/skills/setup-gmail-mcp/SKILL.md`, roughly 40 lines of markdown and no code, instructs Claude Code to drive the flag-based commands, interpret `doctor` output, and register the server via `claude mcp add`. This ships agent-native onboarding in the public repo.

## Documentation

The 255-line README becomes a short entry point plus focused guides.

| File | Contents |
| --- | --- |
| `README.md` (~120 lines) | What it is, tool list, security posture, `npm install && npm run setup` quickstart, links out |
| `docs/google-cloud-setup.md` | Enable Gmail API, consent screen, publishing status and the 7-day expiry, Desktop OAuth client, scopes. Personal vs Workspace differences live here. |
| `docs/accounts.md` | Aliases, labels, `accounts.json` format, adding and removing accounts, token locations |
| `docs/clients.md` | Claude Code, Claude Desktop, Codex, all using `/path/to/gmail-mcp` placeholders |
| `docs/troubleshooting.md` | `403 access_denied`, `invalid_grant` and 7-day expiry, missing refresh token, Workspace admin OAuth restrictions, stale `dist/` |

Across all public docs, `work` and `support` become `work`, `personal`, and `support`, and every `/Users/<user>/...` path is removed.

## Repository hygiene

- `LICENSE`: Apache-2.0, "Copyright 2026 Zero Story Points". A short `NOTICE` file names the org. No per-file license headers; LICENSE and NOTICE alone, which is normal for a repo this size.
- `package.json`: name becomes `@zerostorypoints/gmail-mcp`; adds `license`, `author` (Piotr Dziubecki <piotr@zerostorypoints.com>), `repository`, `homepage`, `bugs`, and `keywords`; retains `"private": true`.
- `SECURITY.md`: which scopes are requested and why, that tokens are local at mode `0600`, that no send or delete tool exists, and how to report an issue (piotr@zerostorypoints.com).
- GitHub metadata: repo description and topics `mcp`, `gmail`, `model-context-protocol`, `claude`, `typescript`.
- `.github/workflows/ci.yml`: Node 20 and 22 matrix running `npm ci`, `typecheck`, `build`, `test`.

## Testing

Node's built-in `node:test` run through `tsx --test`. No new dependencies, no network, no OAuth. Roughly 8-12 tests covering the pure functions that a setup script would otherwise break silently:

- `expandPath` for `~`, `~/x`, relative, and absolute inputs
- default `tokenPath` resolution, including the `GMAIL_MCP_TOKEN_DIR` override
- alias validation accepting and rejecting the right shapes
- accounts-config parse failures producing readable errors
- `ensureAccount` adding a missing alias and leaving an existing one untouched
- `describeAccountError` mapping `invalid_grant` and passing other errors through
- wizard argument parsing

## Local setup on this machine

After the code lands:

1. Authorize `support`, `work`, and any fourth account.
2. Repoint `~/.codex/config.toml` from `Projects/gmail-mcp` to `Projects/_arch/gmail-mcp`.
3. Confirm the Claude Code registration resolves.
4. Run `npm run doctor` until every account reports green.
5. Run a real `gmail_search` against each account to prove it end to end.

## Order of work

1. Extract `src/oauth.ts` from `auth.ts`
2. Config changes: optional `tokenPath`, `label`, `email`, `saveAccountsConfig`, `ensureAccount`
3. Error translation and the `gmail_list_accounts` shape change
4. `setup.ts` and `doctor.ts`
5. Tests and CI
6. Documentation rewrite
7. License, NOTICE, SECURITY.md, package.json metadata
8. Local setup and end-to-end verification
9. Repo transfer to the org, with explicit confirmation first, followed by description and topics

## Out of scope

- Publishing to npm
- Any send, trash, or delete tool
- CONTRIBUTING.md, code of conduct, issue and PR templates
- Git history rewriting, which the clean history makes unnecessary
- Aggregating or unifying mailboxes across accounts

## Risks

**Repo transfer is outward-facing and effectively irreversible.** It runs last, after everything else is verified, and only on explicit confirmation.

**The `gmail_list_accounts` output change breaks any saved prompt** that assumes a flat string array. Only this repo's own docs do, and they are being rewritten in the same pass.

**Self-registering aliases can absorb typos.** `--account wrok` silently creates a junk entry. Mitigated by printing a loud `Added new account alias "wrok" to accounts.json`; the cleanup is a one-line JSON edit.

**The wizard cannot be tested end to end automatically**, because it requires a browser and a live Google consent screen. Unit tests cover its pure logic; the flow itself is verified manually during local setup.
