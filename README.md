# Octomail

Octomail is a local, multi-account Gmail MCP server that exposes several
Gmail accounts side by side to an MCP client, each one addressed by an
explicit alias you choose (`work`, `personal`, `support`, ...). There is no
forwarding, no mailbox aggregation, and no shared token — every account
authorizes and stores its credentials independently.

## Safety

The tool list below deliberately excludes send — there is no way to mail
anything out through this server; `gmail_create_draft` only ever creates a
draft. No tool touches whether a message exists: nothing sends it, deletes
it, or trashes it. The most destructive actions available are deleting a
label or a filter, and both require an explicit `confirm: true` — without it
they return an impact report and change nothing. Deleting a label does not
delete the messages that carried it, only their categorisation. OAuth tokens
are stored locally at file mode `0600`. See [SECURITY.md](SECURITY.md) for
the full policy and how to report a vulnerability.

## Requirements

- Node 20 or newer
- A Google Cloud project with the Gmail API enabled (see
  [docs/google-cloud-setup.md](docs/google-cloud-setup.md))

## Quickstart

```bash
npm install
npm run build
npm run setup
```

The setup wizard collects your OAuth client credentials, authorizes each
account in the browser, verifies every configured account, and prints the
config blocks you paste into your MCP client.

## Tools

- `gmail_list_accounts`
- `gmail_get_profile(account)`
- `gmail_search(account, query, maxResults?)`
- `gmail_search_many(accounts?, query, maxResultsPerAccount?)`
- `gmail_read_message(account, messageId)`
- `gmail_read_thread(account, threadId)`
- `gmail_list_labels(account)`
- `gmail_apply_labels(account, messageIds, addLabelNames?, removeLabelNames?)`
- `gmail_create_label(account, name, textColor?, backgroundColor?, labelListVisibility?, messageListVisibility?)`
- `gmail_update_label(account, label, newName?, textColor?, backgroundColor?, labelListVisibility?, messageListVisibility?, renameDescendants?)`
- `gmail_delete_label(account, label, confirm?)`
- `gmail_archive(account, messageIds)`
- `gmail_create_draft(account, to, subject, body, cc?, bcc?, replyToMessageId?)`
- `gmail_list_filters(account)`
- `gmail_create_filter(account, criteria…, addLabelNames?, removeLabelNames?, forward?)`
- `gmail_delete_filter(account, filterId, confirm?)`
- `gmail_backfill_filter(account, filterId, apply?, maxResults?)`

## Documentation

| Guide | Covers |
| --- | --- |
| [docs/google-cloud-setup.md](docs/google-cloud-setup.md) | Creating the Google Cloud project, OAuth consent screen, and the 7-day token expiry to avoid |
| [docs/accounts.md](docs/accounts.md) | Aliases, `accounts.json`, adding/removing accounts, checking account health |
| [docs/clients.md](docs/clients.md) | Wiring the server into Claude Code, Claude Desktop, and Codex |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Fixes for common authorization and config errors |

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | Interactive wizard: collects OAuth credentials, authorizes accounts, verifies them, prints client config |
| `npm run auth -- --account <alias>` | Authorizes (or re-authorizes) one account by alias |
| `npm run doctor` | Checks environment, build freshness, and every configured account; exits 1 on failure |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm run dev` | Runs the server directly from source with `tsx` |
| `npm test` | Runs the test suite |

## Notes

- `gmail_apply_labels` accepts label display names or Gmail label IDs.
- `gmail_search_many` searches all configured accounts when `accounts` is
  omitted, and returns per-account errors without hiding successful results
  from other accounts.
- `gmail_archive` only removes the `INBOX` label.
- `gmail_create_draft` creates a draft only — there is no send tool.
- Unknown account aliases and missing token files return readable errors.

## License

Apache-2.0. Copyright 2026 Zero Story Points.
