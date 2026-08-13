# Octomail

Octomail is a local, multi-account Gmail MCP server that exposes several
Gmail accounts side by side to an MCP client, each one addressed by an
explicit alias you choose (`work`, `personal`, `support`, ...). There is no
forwarding, no mailbox aggregation, and no shared token — every account
authorizes and stores its credentials independently.

## Safety

Sending exists: `gmail_send_draft` sends real mail. No tool composes and
sends in one call — `gmail_create_draft` only ever creates a draft, and
sending is always a separate, later step against a draft you can open and
read in Gmail first. Without `confirm: true`, `gmail_send_draft` only
reports what it would send — recipients, subject, attachment names and
sizes — and changes nothing. With `confirm: true` it still refuses unless
every address on the draft's To, Cc, and Bcc appears in that account's
`allowedRecipients` in `accounts.json`; an account with no `allowedRecipients`
field cannot send at all, which is the default for every account. An
allowlist entry is a full address (`person@example.com`) or a domain
(`@example.com`); matching is case-insensitive, subdomains are not included,
and a non-ASCII recipient is refused outright rather than normalised, since a
homograph domain can render identically to its Latin lookalike. If the
recipient list contains anything the address extractor cannot fully account
for, the send is refused rather than guessed at. `gmail_create_draft` still
warns, but creates the draft, when a recipient isn't allowlisted — nothing
leaves the account until `gmail_send_draft` runs, so the refusal belongs
there. The OAuth token has always held the `gmail.compose` scope, which
grants sending; the previous version of this guarantee described the tool
surface, not the credential — anything holding an account's tokens could
already send. `gmail_get_attachment` writes files into
`OCTOMAIL_DOWNLOAD_DIR` (default `~/.octomail/attachments/<account>/`) at
file mode `0600` in a directory at `0700`, and outbound file attachments
must live inside that directory. Another way mail can leave an account is
`gmail_create_filter`'s optional `forward` action, which installs a standing
Gmail rule — and Gmail only accepts an address you have already verified on
that account, which this server has no scope to do for you. No tool ever
deletes a message outright, but `TRASH` and `SPAM` are
ordinary Gmail labels, and adding either one to a message — directly via
`gmail_apply_labels`, as a standing rule via `gmail_create_filter`, or applied
to existing mail via `gmail_backfill_filter` — does trash or spam it, and
Gmail purges trashed and spammed mail after 30 days. That is the one label
pair this server gates: adding `TRASH` or `SPAM` requires an explicit
`confirm: true`, and without it the call is refused and nothing changes;
removing them is a recovery action and is never gated. The other most
destructive actions available are deleting a label or a filter, which also
require an explicit `confirm: true` — without it they return an impact report
and change nothing. Deleting a label does not delete the messages that
carried it, only their categorisation. OAuth tokens are stored locally at
file mode `0600`. See [SECURITY.md](SECURITY.md) for the full policy and how
to report a vulnerability.

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

## Starting with Claude

Once the quickstart above has run, register the server with Claude Code:

```bash
claude mcp add octomail --env OCTOMAIL_ACCOUNTS_FILE=/path/to/octomail-mcp/accounts.json -- node /path/to/octomail-mcp/dist/server.js
```

`npm run setup -- --print-config` prints this command with the real paths for
your checkout, plus the equivalent blocks for Claude Desktop and Codex — see
[docs/clients.md](docs/clients.md) for those. Then start a new Claude session
and try:

- "List my Gmail accounts" — confirms the server is wired up and shows the
  aliases you configured.
- "Search work for invoices from last month" — reads mail on the `work`
  alias.
- "Help me clean up my personal inbox" — Claude can survey the mailbox,
  propose labels and filters, and backfill them; give it
  [docs/filter-playbook.md](docs/filter-playbook.md) for the field-tested
  workflow to follow.

Claude asks before anything state-changing, and the server refuses trash,
spam, and deletion actions unless the call carries an explicit
`confirm: true` (see Safety above).

## Tools

- `gmail_list_accounts`
- `gmail_get_profile(account)`
- `gmail_search(account, query, maxResults?)`
- `gmail_search_many(accounts?, query, maxResultsPerAccount?)`
- `gmail_read_message(account, messageId)`
- `gmail_read_thread(account, threadId)`
- `gmail_list_labels(account)`
- `gmail_apply_labels(account, messageIds, addLabelNames?, removeLabelNames?, confirm?)`
- `gmail_create_label(account, name, textColor?, backgroundColor?, labelListVisibility?, messageListVisibility?)`
- `gmail_update_label(account, label, newName?, textColor?, backgroundColor?, labelListVisibility?, messageListVisibility?, renameDescendants?)`
- `gmail_delete_label(account, label, confirm?)`
- `gmail_archive(account, messageIds)`
- `gmail_create_draft(account, to, subject, body, cc?, bcc?, replyToMessageId?, attachments?)`
- `gmail_list_drafts(account, maxResults?)`
- `gmail_get_draft(account, draftId)`
- `gmail_update_draft(account, draftId, to, subject, body, cc?, bcc?, attachments?)`
- `gmail_delete_draft(account, draftId, confirm?)`
- `gmail_send_draft(account, draftId, confirm?)`
- `gmail_get_attachment(account, messageId, attachmentId, encoding?)`
- `gmail_list_filters(account)`
- `gmail_create_filter(account, from?, to?, subject?, query?, negatedQuery?, hasAttachment?, excludeChats?, size?, sizeComparison?, addLabelNames?, removeLabelNames?, forward?, confirm?)`
- `gmail_delete_filter(account, filterId, confirm?)`
- `gmail_backfill_filter(account, filterId, apply?, maxResults?, pageToken?, confirm?)`
- `calendar_list_calendars(account)`
- `calendar_list_events(account, calendarId?, timeMin, timeMax, maxResults?)` — returns title, time, location, and attendee count, but omits the event description (typically auto-pasted conference meeting IDs and access codes)
- `calendar_respond_to_event(account, calendarId?, eventId, response, comment?)` — answers an invitation as the calling account (`accepted`, `declined`, `tentative`). It rewrites the `responseStatus` of the one attendee entry carrying this account's own address, leaves every other attendee and every other field of the event as it found them, and sends no notification mail of its own — the answer reaches the organizer's copy of the event either way. It cannot create, move, or delete an event, and it refuses a recurring series id, which would answer for every occurrence at once.

## Documentation

| Guide | Covers |
| --- | --- |
| [docs/google-cloud-setup.md](docs/google-cloud-setup.md) | Creating the Google Cloud project, OAuth consent screen, and the 7-day token expiry to avoid |
| [docs/accounts.md](docs/accounts.md) | Aliases, `accounts.json`, adding/removing accounts, checking account health |
| [docs/clients.md](docs/clients.md) | Wiring the server into Claude Code, Claude Desktop, and Codex |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Fixes for common authorization and config errors |
| [docs/filter-playbook.md](docs/filter-playbook.md) | Field-tested workflow and lessons for cleaning up a mailbox with filters, backfills, and verification |

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
- `gmail_create_draft` and `gmail_update_draft` create or replace a draft
  only; `gmail_send_draft` is the one tool that transmits mail, and it is
  gated as described in Safety above.
- Unknown account aliases and missing token files return readable errors.

## License

Apache-2.0. Copyright 2026 Zero Story Points.
