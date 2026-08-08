# Security Policy

## What this server can do

This MCP server talks to the Gmail API on your behalf using these OAuth scopes:

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Search, read messages and threads, list labels |
| `gmail.modify` | Apply and remove labels, archive messages — including adding `TRASH`/`SPAM`, which trashes or spams a message |
| `gmail.compose` | Create drafts |
| `gmail.settings.basic` | List, create, and delete filters |

There is deliberately **no tool that sends mail or deletes a message**. But
`TRASH` and `SPAM` are ordinary Gmail labels, and adding either one — via
`gmail_apply_labels`, as a standing rule via `gmail_create_filter`, or applied
to existing mail via `gmail_backfill_filter` — does trash or spam the message,
and Gmail purges trashed and spammed mail after 30 days. Adding `TRASH` or
`SPAM` is therefore the one label pair that requires an explicit
`confirm: true`; without it the call is refused and nothing changes. Removing
them is a recovery action and is not gated. The server can also delete two
kinds of metadata — labels and filters — and each of those likewise requires
an explicit `confirm: true`; without it the tool returns an impact report and
changes nothing. Deleting a label leaves its messages intact and removes only
their categorisation.

One capability does let mail leave an account: `gmail_create_filter` accepts an
optional `forward` action, which installs a standing Gmail forwarding rule.
Gmail only accepts a forwarding address already verified on that account, and
this server does not request `gmail.settings.sharing`, so it cannot verify a
new destination for you.

## Where your credentials live

- OAuth client ID and secret stay in a local `.env` file, written at mode
  `0600` when `npm run setup` creates it. If you hand-write `.env` instead,
  run `chmod 600 .env` yourself — your umask likely leaves it at `0644`.
- The client ID and secret can instead live in a downloaded `credentials.json`
  (via `GOOGLE_OAUTH_CREDENTIALS_FILE`). Nothing chmods this file for you;
  run `chmod 600 credentials.json` after downloading it.
- Per-account OAuth tokens are written outside the repository, by default under
  `~/.octomail/tokens/`, each at mode `0600`.
- `.env`, `accounts.json`, and `credentials.json` are all git-ignored. No
  credential has ever been committed to this repository.
- The server speaks stdio to a local MCP client. It opens no network listener,
  except a temporary loopback callback on `127.0.0.1` during authorization.

## Reporting a vulnerability

Email piotr@zerostorypoints.com. Please do not open a public issue for a
security report. Expect an acknowledgement within a week.
