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
    "work": { "label": "Work (Google Workspace)" },
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
