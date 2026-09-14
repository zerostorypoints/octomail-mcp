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
carried it, only their categorisation. The Drive tools can create folders,
upload a Gmail attachment, move or rename a file, copy a file into a
folder on the same account, and move a file to the Drive trash; nothing on
Drive is ever permanently deleted or shared, the trash step needs the file's
exact current name and `confirm: true` (a folder also `confirmFolder: true`),
and the only bytes a Drive tool ever uploads are a Gmail attachment
already on the same account (a copy is made by Drive itself, with no bytes
passing through this server). One Drive tool
reads content: `drive_export_file` returns the text of a Google Sheet (one
tab, as CSV) or a Google Doc (as plain text), capped at 200 KB in the
result, and writes a larger export into the account's download directory
under a fresh name instead of overwriting anything. It never downloads a
binary file — a PDF, an image, or an uploaded spreadsheet is refused. A
file already named that in the target folder makes the upload, move, or copy
refuse rather than overwrite it. OAuth tokens are stored locally at
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
- `calendar_create_event(account, calendarId?, summary, start?, end?, startDate?, endDate?, description?, location?, attendees?, sendUpdates?)` — a timed event needs `start` and `end` as RFC3339 timestamps **carrying a UTC offset**, because Google reads an offset-less timestamp in the calendar's own zone; an all-day event needs `startDate` and `endDate`, where `endDate` is **exclusive**. Attendees are gated on the account's `allowedRecipients`, the same list that gates sending, since a guest receives the invitation. `sendUpdates` defaults to `none`.
- `calendar_update_event(account, calendarId?, eventId, summary?, start?, end?, startDate?, endDate?, description?, location?, attendees?, sendUpdates?, confirmSeries?)` — writes only the fields passed, except `attendees`, which replaces the whole guest list. The event is read first and written back under `If-Match` with the etag from that read, so a change made elsewhere in the meantime fails the write instead of overwriting it. A call naming no field is refused rather than sent as a no-op edit, and a recurring series id needs `confirmSeries: true`.
- `ical_list_feeds()` — lists the subscribed iCal feeds configured under `calendarFeeds` in `accounts.json`, by alias and host. The URL itself is withheld from the result: a feed link is a bearer token for the whole calendar, and results end up in transcripts.
- `ical_list_events(feed, timeMin, timeMax, maxResults?)` — reads one feed. Recurrence rules are expanded into individual occurrences, `EXDATE` exclusions are honoured, and an override of a single occurrence replaces that occurrence instead of appearing as a second event. Takes a **feed alias, never a URL**, so nothing read from a page or a message can make this server fetch an arbitrary host. Feeds are read-only by nature: an `.ics` subscription is a file served over HTTP and has no write protocol — to get a writable copy, mirror it into a real Google calendar.
- `calendar_delete_event(account, calendarId?, eventId, confirm?, confirmSeries?, sendUpdates?)` — **cannot be undone**: Google Calendar keeps no trash for events. Without `confirm: true` it deletes nothing and returns the event it would delete, so the decision is made against the real title and time. Also guarded by `If-Match`, and a series id needs `confirmSeries: true`.
- `drive_list_files(account, folderId?, nameContains?, foldersOnly?, maxResults?, pageToken?)` — lists the children of a folder (default the account's My Drive root) or searches all of Drive, including shared drives, by a name fragment; pass `folderId` or `nameContains`, not both. Read-only: it never returns file content.
- `drive_create_folder(account, name, parentId?)` — creates a folder, or if one of that name already exists directly under the given parent, returns it instead with `created: false` and creates nothing.
- `drive_save_attachment(account, messageId, attachmentId, folderId, name?)` — saves a Gmail attachment straight into a Drive folder; the bytes go directly from Gmail to Drive, never through local disk. `folderId` is required, and the new file's description records the source account, message id, subject, sender, and date. Refuses, naming the existing file's id, when a file with the target name already exists in that folder, rather than overwriting it.
- `drive_move_file(account, fileId, folderId?, name?)` — moves a Drive file to a different folder, renames it, or both in one call, removing it from every previous parent. Refuses when a file with the resulting name already exists in the target folder. Cannot copy the file or move it to a different account.
- `drive_move_files(account, items[{fileId, folderId?, name?}])` — the batch form of `drive_move_file`: up to 100 rows in one call, in order, one result row per item (`moved` with the previous parents and name, or `refused` with the reason); a refused row never stops the others. Same checks as the single tool.
- `drive_copy_file(account, fileId, targetFolderId, newName?)` — copies a Drive file into a folder on the same account, under `newName` or the source's own name. A Google Doc or Sheet copies as the same Google type, a binary file byte for byte, and a copy from My Drive into a shared drive works; Drive performs the copy, so no bytes pass through this server. The copy's description records the source file id, name, and time, appended to any description the source already carried. Refuses, naming the existing file's id, when a file with the resulting name already exists in the target folder, and refuses a folder as the source. Never modifies the source and cannot delete, move, or overwrite anything.
- `drive_trash_file(account, fileId, expectedName, confirm?, confirmFolder?)` — moves one Drive file or folder to the Drive trash (`files.update` with `trashed=true`), where Drive keeps it for 30 days and it can be restored; never a permanent delete, there is no `files.delete` and no `emptyTrash` in this server. `expectedName` must equal the file's current name (compared after Unicode NFC normalisation, so a macOS-uploaded name with decomposed accents still matches), so a wrong or stale id is refused. The result carries the file's `owners`; when Drive refuses the trash because this account is not the owner, the refusal names the owner. Without `confirm: true` it changes nothing and returns the file it would trash; a folder additionally needs `confirmFolder: true`, because trashing a folder trashes its contents. Refuses a file already in the trash.
- `drive_trash_files(account, items[{fileId, expectedName}], confirm?, confirmFolder?)` — the batch form of `drive_trash_file` for an accepted list: up to 100 rows in one call, processed in order, one result row per item with `trashed`, `wouldTrash` or `refused` and the reason; a refused row never stops the others. Same guards, same trash-only outcome.
- `drive_create_spreadsheet(account, name, folderId, sheets[{title, rows}], valueInput?)` — creates a new Google Sheet in a folder (My Drive or a shared drive) and fills its tabs in one call: up to 20 tabs and 20 000 cells, the first tab replacing the default one. Refuses a same-named file in the folder and never writes into an existing spreadsheet. `valueInput` is `USER_ENTERED` by default (numbers and dates parsed as when typed) or `RAW` (every cell literal text). Uses the Sheets API under the existing `drive` scope. If filling fails after the file was created, the error names the new id so it can be trashed.
- `drive_export_file(account, fileId, sheet?)` — reads a Google Sheet as CSV (one tab; `sheet` picks it by title, default the first) or a Google Doc as plain text. Google-native documents only: any other mime type is refused before any content request. The result's `text` is capped at 200 KB, cut on a line boundary; when cut, `truncated: true` and the full text is written into `OCTOMAIL_DOWNLOAD_DIR/<account>` with the path in `savedTo`, never overwriting an existing file. Sheets are read through the Google Sheets API under the existing `drive` scope, so that API must be enabled on the Cloud project.

## Documentation

| Guide | Covers |
| --- | --- |
| [docs/google-cloud-setup.md](docs/google-cloud-setup.md) | Creating the Google Cloud project, OAuth consent screen, and the 7-day token expiry to avoid |
| [docs/accounts.md](docs/accounts.md) | Aliases, `accounts.json`, adding/removing accounts, checking account health |
| [docs/clients.md](docs/clients.md) | Wiring the server into Claude Code, Claude Desktop, and Codex |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Fixes for common authorization and config errors |
| [docs/filter-playbook.md](docs/filter-playbook.md) | Field-tested workflow and lessons for cleaning up a mailbox with filters, backfills, and verification |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The no-real-user-data rule for code, tests and docs, and the 2026-09-14 history rewrite |

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
