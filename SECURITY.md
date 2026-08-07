# Security Policy

## What this server can do

This MCP server talks to the Gmail API on your behalf using these OAuth scopes:

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Search, read messages and threads, list labels |
| `gmail.modify` | Apply and remove labels, archive messages |
| `gmail.compose` | Create drafts |

There is deliberately **no tool that sends mail, trashes, or deletes anything**.
The most destructive action available is removing the `INBOX` label from a
message, which archives it. Nothing is ever permanently removed.

## Where your credentials live

- OAuth client ID and secret stay in a local `.env` file, written at mode `0600`.
- Per-account OAuth tokens are written outside the repository, by default under
  `~/.gmail-multi-mcp/tokens/`, each at mode `0600`.
- `.env`, `accounts.json`, and `credentials.json` are all git-ignored. No
  credential has ever been committed to this repository.
- The server speaks stdio to a local MCP client. It opens no network listener,
  except a temporary loopback callback on `127.0.0.1` during authorization.

## Reporting a vulnerability

Email piotr@zerostorypoints.com. Please do not open a public issue for a
security report. Expect an acknowledgement within a week.
