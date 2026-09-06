# Troubleshooting

## `403 access_denied`, "app can only be accessed by developer-approved testers"

**Cause:** Your Google OAuth app is in Testing publishing status, and the
Gmail address you signed in with is not on the test-user list — or your
browser was signed into a different Google account than the one you meant to
authorize.

**Fix:** Add the exact address as a test user (see
[docs/google-cloud-setup.md](google-cloud-setup.md)), wait a minute for it to
take effect, and retry in a private/incognito browser window to avoid an
existing Google session getting in the way. Better long-term fix: move the app
to **In Production**, described in the same doc, which also removes the
7-day token expiry below.

## `Gmail account "..." authorization has expired or was revoked`

**Cause:** Almost always the Testing-mode 7-day refresh token expiry — see
[docs/google-cloud-setup.md](google-cloud-setup.md#3-publishing-status-use-in-production)
for why this happens. It can also mean you manually revoked the grant.

**Fix:** Move the OAuth app to **In Production** so this stops recurring, then
re-authorize the affected account:

```bash
npm run auth -- --account <alias>
```

## `... was authorized before Octomail requested filter access`

Filter tools need the `gmail.settings.basic` scope, which was added after the
first release. Accounts authorized before that have tokens without it. Every
other tool keeps working; only the filter tools fail.

Fix it per account:

    npm run auth -- --account <alias>

Approve the additional permission on the consent screen. `npm run doctor` marks
affected accounts with a `!` line reading "no filter scope". An account
authorized before Drive access was requested gets the same treatment — a
`!` line reading "no drive scope" — and only the Drive tools are affected.

If you are a Google Workspace admin and the consent screen refuses the scope for
your domain, allow the OAuth client under **Admin console > Security > Access and
data control > API controls > Manage third-party app access**.

## "Google did not return a refresh token"

**Cause:** This Gmail account was already authorized once before, and Google
only issues a refresh token on the first consent for a given app/account
pair.

**Fix:** Revoke the existing grant at
[Google Account access settings](https://myaccount.google.com/permissions),
then run `npm run auth -- --account <alias>` again.

## Workspace admin blocks the app

**Cause:** A Google Workspace admin can block third-party OAuth apps for the
whole domain. Authorization fails even though the user is correctly listed as
a test user.

**Fix:** Ask the Workspace admin to allow this OAuth app, or to approve the
specific Gmail scopes it requests (see the scopes table in
[docs/google-cloud-setup.md](google-cloud-setup.md#7-scopes-requested)).

## Tools missing or stale in the client

**Cause:** `dist/` is out of date relative to `src/`, or the MCP client hasn't
restarted since the server or its config changed.

**Fix:**

```bash
npm run build
```

then restart the client. `npm run doctor` reports a stale build directly, as
a `✗ dist/ is older than src/` line.

## `Accounts config not found`

**Cause:** No `accounts.json` exists yet at the expected path.

**Fix:** Run `npm run setup`, or copy the example file:

```bash
cp accounts.example.json accounts.json
```

or set `OCTOMAIL_ACCOUNTS_FILE` to point at wherever your config actually
lives.

## The setup wizard exits saying there is no interactive terminal

**Cause:** `npm run setup` needs to prompt you interactively, so it refuses to
run without a real terminal attached — this is expected when it's run by an
agent, a script, or through a pipe.

**Fix:** Pass what you need as flags instead:

```bash
npm run setup -- --account work --label "Work Mail"
```
