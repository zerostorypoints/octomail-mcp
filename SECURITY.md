# Security Policy

## What this server can do

This MCP server talks to the Gmail API on your behalf using these OAuth scopes:

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Search, read messages and threads, list labels |
| `gmail.modify` | Apply and remove labels, archive messages — including adding `TRASH`/`SPAM`, which trashes or spams a message |
| `gmail.compose` | Create drafts, and send them via `gmail_send_draft` — this scope has always granted send |
| `gmail.settings.basic` | List, create, and delete filters |
| `calendar.readonly` | List calendars and events |
| `calendar.events` | Create, update, and delete events via `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`; answer invitations via `calendar_respond_to_event`; also covers a planned busy-block sync between calendars, which has no tool yet |
| `drive` | List folders and files, create folders, upload a Gmail attachment, move or rename, read a Google Sheet or Doc as text (the Sheets API accepts this scope); full scope because `drive.file` cannot see folders the app did not create |

Four registered tools write to a calendar: `calendar_create_event`, `calendar_update_event`,
`calendar_delete_event`, and `calendar_respond_to_event`. Of those, `calendar_respond_to_event`
writes only the calling account's own `responseStatus`, plus an optional comment to the organizer.

The entry it rewrites has to satisfy two conditions: it carries the account's own
address (from `accounts.json`, or from Google if that is not recorded yet), and Google
marks it `self`. Google's `self` flag alone would not do — it marks the attendee whose
calendar the copy was read from, so on a shared calendar the account has write access
to, `self` is the calendar owner, and answering by `self` would rewrite their answer.
An event that lists the account twice, or not at all, is refused rather than guessed at,
as is a recurring series id, which would answer for every occurrence at once.

The write is a field-scoped `patch` of the attendee list guarded by the event's `etag`;
an event that arrives without one is refused rather than written unguarded, and a
concurrent change by someone else fails the write instead of being silently reverted.
`sendUpdates` is `none`: the answer propagates to the organizer's copy of the event on
its own, whereas notification mail would put text this server was handed — event ids and
comments can originate in mail written by third parties — into every guest's inbox.

Beyond those four tools, `calendar.events` also covers a planned busy-block sync
between calendars, which still has no tool; a granted scope does nothing by itself,
only a registered tool that calls it can act.

The six Drive tools can list folders and files, create a folder, upload a Gmail
attachment into a folder, move or rename a file, copy a file into a folder on the
same account, and read a Google Sheet or Doc as text. No Drive tool deletes, trashes, or shares. One, `drive_export_file`, reads
content, and only the rendered text of a Google Sheet or Google Doc: it refuses every
other mime type before any content request, so no binary file on Drive can be pulled
through this server. Its result is capped at 200 KB; a larger export is written into
the account's download directory under a fresh name. `drive_save_attachment`, `drive_move_file` and `drive_copy_file` each
refuse rather than overwrite when a file of the target name already exists in the
destination folder; `drive_copy_file` never touches its source. The restriction above is the tool surface, not the token: the
granted scope is full `drive`, which permits delete, trash, share, and read of every
file on that account's Drive, so anything holding the token file can do all four,
regardless of what this server's tool surface offers.

`gmail.compose` grants send, and every account has held it since it first
authorized — a token holder could always send mail through the Gmail API,
regardless of what this server's tool surface offered. What changed is the
tool surface: `gmail_send_draft` now exists, is the only tool that calls
`drafts.send`, and is the only way this server itself will transmit mail.
There is deliberately no tool that composes and sends in one call — sending
is always a second step against a draft that already exists and that you can
read in Gmail first. The control that actually bounds outbound mail is the
per-account `allowedRecipients` allowlist in `accounts.json`
(see [docs/accounts.md](docs/accounts.md)): `gmail_send_draft` refuses to
send, even with `confirm: true`, unless every address on the draft's To, Cc,
and Bcc is on that account's allowlist, and an account with no
`allowedRecipients` field cannot send at all — that is the default for every
account. Without `confirm: true`, `gmail_send_draft` only reports what it
would send and changes nothing. `gmail_create_draft` still creates a draft
addressed to a non-allowlisted recipient, with a warning; nothing has left
the account at that point, so the refusal belongs on the send step, not the
draft step. `gmail_delete_draft` also requires `confirm: true` — a deleted
draft does not go to Trash and cannot be recovered. Outbound file
attachments (and `gmail_get_attachment` downloads) are confined to
`OCTOMAIL_DOWNLOAD_DIR`, written at file mode `0600` in a directory at
`0700`.

There is deliberately **no tool that deletes a message**. But
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

Mail can also leave an account another way: `gmail_create_filter` accepts an
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
