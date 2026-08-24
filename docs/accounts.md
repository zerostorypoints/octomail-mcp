# Accounts

## What an alias is

Every Gmail account you connect gets a short local name, the **alias**. It's
the string an MCP client passes as the `account` parameter on every tool call
— `gmail_search(account: "work", ...)`, for example. Aliases may contain
letters, digits, underscores, and hyphens. Keep them short and stable, since
you (and your MCP client's saved prompts) will type them often: `work`,
`personal`, `support` rather than the mailbox's full email address.

## Adding an account

```bash
npm run auth -- --account work --label "Work Mail"
```

This runs the OAuth flow for `work`: it opens a browser, you sign in and
approve access, and the token is saved locally. If `work` isn't already in
`accounts.json`, the command creates it for you and prints:

```
Added new account alias "work" to accounts.json.
```

No hand-editing of `accounts.json` is required to add an account — `--label`
is optional and just sets the free-text description stored alongside it.

## The `accounts.json` format

```json
{
  "accounts": {
    "personal": { "label": "Personal Gmail" },
    "work": {
      "label": "Work (Google Workspace)",
      "allowedRecipients": ["@example.com", "accountant@partner.example"]
    },
    "support": {}
  }
}
```

Every field on an account entry is optional:

| Field | Meaning |
| --- | --- |
| `tokenPath` | Where the OAuth token is stored. Defaults to `~/.octomail/tokens/<alias>.json`. |
| `label` | Free text you write, for your own reference. Not used by the server logic. |
| `email` | The account's real Gmail address, refreshed automatically after every successful authorization. Don't hand-edit this — let `npm run auth` fill it in. |
| `allowedRecipients` | The recipient allowlist that `gmail_send_draft` checks before sending. See below. |

In the example above, `personal` and `support` have no `allowedRecipients`
field, so `gmail_send_draft` refuses to send anything on either account —
that is the default for every account until you add the field.

## `calendarFeeds`: subscribed iCal feeds

Feeds sit beside `accounts`, not inside one, because a subscribed `.ics` feed
belongs to no account: it is a URL, readable by anyone holding the link, with
no OAuth and no mailbox behind it.

```json
{
  "accounts": { "work": {} },
  "calendarFeeds": {
    "holidays": { "url": "webcal://example.com/holidays.ics", "label": "Public holidays" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `url` | The subscription link. `webcal://` is accepted and rewritten to `https://`, which is what it already is on the wire. Plain `http://` is refused — the URL is a bearer secret for the whole calendar and must not travel in clear. |
| `label` | Free text you write, for your own reference. |

`ical_list_events` takes the **alias**, never a URL. That is deliberate: a tool
that fetched whatever URL it was handed would let anything this server reads —
a web page, a message, an event description — steer it at an arbitrary host.

These feeds are read-only, and not by choice: iCalendar over HTTP has no write
verb. To edit the events, mirror the feed into a real Google calendar and edit
the copy with `calendar_update_event`. If the source is iCloud, Fastmail, or
Nextcloud, it also speaks CalDAV, which does support writing — that would be a
separate client with its own credentials.

## `allowedRecipients`: who an account can send to

`gmail_send_draft` is the only tool that transmits mail, and it will not send
unless every address on the draft's To, Cc, and Bcc is covered by the
account's `allowedRecipients` list. An account with no `allowedRecipients`
field cannot send at all, regardless of what `gmail_create_draft` was told to
address the draft to.

Each entry in the list is one of two forms:

- A full address: `"person@example.com"` — permits sending to that address
  only.
- A domain: `"@example.com"` — permits sending to any address at that exact
  domain.

Notes on matching:

- Matching is case-insensitive.
- Domain entries do **not** cover subdomains: `"@example.com"` does not
  permit `x@mail.example.com`. Add `"@mail.example.com"` separately if you
  need that.
- Entries must be ASCII. `npm run auth` and the server both reject a
  non-ASCII entry at load time, because a Cyrillic homograph domain renders
  identically to its Latin lookalike and there is no safe way to tell them
  apart automatically.
- If Gmail's own recipient headers on the draft contain anything the address
  extractor can't fully account for, `gmail_send_draft` refuses the send
  rather than guess which parts are addresses.

`gmail_create_draft` will still create a draft addressed to a recipient
outside the allowlist — it returns a warning instead of failing, since
nothing has actually left the account yet. The refusal happens at
`gmail_send_draft`, the irreversible step.

## Where tokens live

By default, each account's OAuth token is written to
`~/.octomail/tokens/<alias>.json` at file mode `0600` (readable and
writable only by you). Set `OCTOMAIL_TOKEN_DIR` to use a different directory
for all accounts.

Each alias needs its own token file. Never point two aliases at the same
`tokenPath` — the server has no way to detect that and will use whichever
token it reads last.

## Checking which accounts work

```bash
npm run doctor
```

prints an `Environment:` block (Node version, build freshness, OAuth client
credentials) and an `Accounts:` block, one line per configured alias:

```
Accounts:
  ✓ work         → work@example.com
  ✗ support      — not authorized, run: npm run auth -- --account support
```

`npm run doctor` exits with status 1 if anything is wrong, so it's safe to use
in a script or as a quick sanity check after setup.

## Removing an account

1. Delete the account's entry from `accounts.json`.
2. Delete its token file (see "Where tokens live" above).
3. Revoke the OAuth grant at
   [Google Account access settings](https://myaccount.google.com/permissions)
   so the app can no longer access that mailbox at all.
