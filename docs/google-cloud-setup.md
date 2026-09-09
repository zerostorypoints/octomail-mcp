# Google Cloud setup

This server talks to Gmail through your own Google Cloud project. You create the
project once, then every account you add authorizes against it. Nothing here is
Gmail-account-specific until the "Test users" step below.

## 1. Create a project and enable the Gmail, Calendar, Drive, and Sheets APIs

Open the [Google Cloud Console](https://console.cloud.google.com/) and create a
new project (or pick an existing one you're comfortable using). Then go to
**APIs & Services > Library**, search for "Gmail API", and enable it. The
Google Calendar API is a separate library entry in the same project — search
for "Google Calendar API" and enable it too. Until it's enabled, the calendar
tools fail with Google's `SERVICE_DISABLED` / `accessNotConfigured` 403.
`calendar.readonly` must also be listed among the scopes on the OAuth consent
screen's scope configuration (step 2 below). The Google Drive API is a third
library entry in the same project — search for "Google Drive API" and enable
it too, or the Drive tools fail the same way. The Google Sheets API is a
fourth — `drive_export_file` reads spreadsheet tabs through it, under the
Drive scope, and refuses with a message naming this step until it is enabled.

## 2. Configure the OAuth consent screen

Go to **APIs & Services > OAuth consent screen** and fill in an app name, a
support email, and a developer contact email.

For **user type**, choose **External** if you plan to authorize a mix of
personal Gmail addresses and Google Workspace addresses, which is the common
case. **Internal** only works if every account you'll ever add belongs to the
same Workspace organization as the project itself — pick it only if that's
true and stays true.

## 3. Publishing status: use "In Production"

This is the step people skip and regret.

A Google OAuth app with user type **External** that is still in **Testing**
publishing status issues refresh tokens that **expire after 7 days**. With
several Gmail accounts wired into this server, that means re-running
`npm run auth` for every single account, every week, forever. It's easy to
miss until an account quietly stops working and every tool call against it
fails with an expired-authorization error.

Moving the app to **In Production** removes that limit — refresh tokens no
longer expire on a fixed schedule. The trade-off is small for personal use: an
unverified production app shows Google's "Google hasn't verified this app"
warning screen during authorization, which you click through via **Advanced >
Go to (your app name)**. Unverified production apps are also capped at 100
users total, which does not matter for a personal or small-team Gmail
integration.

To switch: on the OAuth consent screen page, click **Publish App**, and
confirm you want production status. You do not need to submit for
verification.

Reference:
https://developers.google.com/identity/protocols/oauth2/production-readiness/overview

## 4. Test users (only if you stay in Testing)

If you choose to stay in Testing status anyway, add every Gmail address you
intend to authorize under **Audience > Test users**, exactly as it appears in
Gmail (matching case doesn't matter, but typos do). An address missing from
this list fails authorization with `403 access_denied`; see
[docs/troubleshooting.md](troubleshooting.md).

## 5. Create the OAuth client

Go to **APIs & Services > Credentials**, click **Create Credentials > OAuth
client ID**, and choose application type **Desktop app**.

The Desktop app type matters: this project's auth flow opens a temporary local
web server and redirects Google back to
`http://127.0.0.1:<port>/oauth2callback`, a loopback address. Only the Desktop
app client type permits that loopback redirect; Web application clients
require pre-registered redirect URIs and will reject it.

## 6. Give the credentials to the project

You have three options, in order of convenience:

- Run `npm run setup` and paste the client ID and secret when prompted.
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
- Download the OAuth client's JSON file and point `GOOGLE_OAUTH_CREDENTIALS_FILE`
  at it.

## 7. Scopes requested

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Search, read messages and threads, list labels |
| `gmail.modify` | Apply and remove labels, archive messages — including adding `TRASH`/`SPAM`, which trashes or spams a message |
| `gmail.compose` | Create drafts |
| `gmail.settings.basic` | List, create, and delete filters |
| `calendar.readonly` | List calendars and events |
| `calendar.events` | Requested for a planned future feature (busy-block sync between calendars); no registered tool uses it yet |
| `drive` | List folders and files, create folders, upload a Gmail attachment, move or rename, read a Google Sheet or Doc as text (the Sheets API accepts this scope); full scope because `drive.file` cannot see folders the app did not create |

Adding a scope to this list means every already-authorized account is
missing it until it re-runs `npm run auth -- --account <alias>` and approves
the new permission; `npm run doctor` says which accounts are affected and
for which scope.

There is deliberately **no tool that deletes a message outright**. Sending mail
does exist: `gmail_send_draft` sends an existing draft, but only behind
`confirm: true` and only when every recipient is on the account's
`allowedRecipients` allowlist; see [SECURITY.md](../SECURITY.md) for the full
policy. But `TRASH` and `SPAM` are ordinary Gmail labels, and adding either one — via
`gmail_apply_labels`, as a standing rule via `gmail_create_filter`, or applied
to existing mail via `gmail_backfill_filter` — does trash or spam the message,
and Gmail purges trashed and spammed mail after 30 days. Adding `TRASH` or
`SPAM` is therefore the one label pair that requires an explicit
`confirm: true`; without it the call is refused and nothing changes. Removing
them is a recovery action and is not gated. See [SECURITY.md](../SECURITY.md)
for the full policy.

## 8. Personal Gmail vs Google Workspace

This project treats a personal `@gmail.com` address and a Google Workspace
address identically: same config format, same commands, same local token
storage. There is no separate code path.

The only two differences live outside this project entirely:

- **Consent screen user type**, covered in step 2 above.
- **Workspace admin restrictions.** A Workspace admin can block third-party
  OAuth apps for their domain regardless of test-user settings. If
  authorization fails for a Workspace address even though it's on the test-user
  list, the admin needs to allow this OAuth app, or approve the Gmail scopes it
  requests.
