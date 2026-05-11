# Gmail Multi MCP

Local MCP server for using several Gmail accounts from Codex in parallel. Each account is addressed explicitly with an `account` alias such as `work`, `private`, or `support`. There is no forwarding, mailbox aggregation, or shared Gmail token.

## Tools

- `gmail_list_accounts`
- `gmail_get_profile(account)`
- `gmail_search(account, query, maxResults?)`
- `gmail_read_message(account, messageId)`
- `gmail_read_thread(account, threadId)`
- `gmail_list_labels(account)`
- `gmail_apply_labels(account, messageIds, addLabelNames?, removeLabelNames?)`
- `gmail_archive(account, messageIds)`
- `gmail_create_draft(account, to, subject, body, cc?, bcc?, replyToMessageId?)`

The server intentionally does not expose trash/delete or send-mail tools.

## Local Files

Do not commit real credentials, account config, or tokens.

- `.env` is ignored by git.
- `accounts.json` is ignored by git.
- `credentials.json` is ignored by git.
- OAuth tokens are stored outside the repo by default, for example `~/.gmail-multi-mcp/tokens/work.json`.

Create your local config:

```bash
cp accounts.example.json accounts.json
cp .env.example .env
```

Edit `accounts.json`:

```json
{
  "accounts": {
    "work": {
      "tokenPath": "~/.gmail-multi-mcp/tokens/work.json"
    },
    "private": {
      "tokenPath": "~/.gmail-multi-mcp/tokens/private.json"
    }
  }
}
```

## Google Cloud OAuth Setup

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Go to **APIs & Services > Library**.
4. Enable **Gmail API**.
5. Go to **APIs & Services > OAuth consent screen**.
6. Choose **External** for personal Gmail accounts, or **Internal** for a Google Workspace-only app.
7. Fill in the app name, support email, and developer contact email.
8. Add your Gmail addresses as test users if the app is in testing mode.
9. Go to **APIs & Services > Credentials**.
10. Click **Create Credentials > OAuth client ID**.
11. Choose **Desktop app**.
12. Copy the client ID and client secret into `.env`:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Alternatively, download the OAuth JSON as `credentials.json` in this folder, or set:

```bash
GOOGLE_OAUTH_CREDENTIALS_FILE=/absolute/path/to/credentials.json
```

The auth helper uses a temporary local loopback callback URL such as `http://127.0.0.1:<port>/oauth2callback`, which is supported by Google OAuth Desktop clients.

## Authorize Accounts

Authorize each alias independently:

```bash
npm run auth -- --account work
npm run auth -- --account private
npm run auth -- --account support
```

The command prints a Google authorization URL, waits for the local browser callback, and writes the token to the `tokenPath` from `accounts.json` with file mode `0600`. It does not print OAuth tokens.

If Google does not return a refresh token, revoke the app grant for that account at [Google Account access settings](https://myaccount.google.com/permissions), then run the auth command again.

## Build and Run

```bash
npm install
npm run typecheck
npm run build
npm start
```

For local development:

```bash
npm run dev
```

## Add To Codex

Add an MCP server entry to `~/.codex/config.toml`.

Recommended version, using `.env` in this project directory:

```toml
[mcp_servers.gmail_multi]
command = "node"
args = ["/Users/<user>/Projects/gmail-mcp/dist/server.js"]
env = { GMAIL_MCP_ACCOUNTS_FILE = "/Users/<user>/Projects/gmail-mcp/accounts.json" }
```

If Codex does not load `.env` from the server project directory in your setup, put the OAuth credentials in the MCP `env` map instead:

```toml
[mcp_servers.gmail_multi]
command = "node"
args = ["/Users/<user>/Projects/gmail-mcp/dist/server.js"]
env = { GMAIL_MCP_ACCOUNTS_FILE = "/Users/<user>/Projects/gmail-mcp/accounts.json", GOOGLE_CLIENT_ID = "your-client-id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET = "your-client-secret" }
```

After changing Codex MCP config, restart Codex so it discovers the server.

## Example Prompts In Codex

```text
Use gmail_search with account private and query "from:alice@example.com newer_than:30d".
```

```text
Read thread THREAD_ID from account work.
```

```text
Archive these message IDs in account support: ...
```

## Notes

- `gmail_apply_labels` accepts label display names or Gmail label IDs.
- `gmail_archive` only removes the `INBOX` label.
- `gmail_create_draft` creates a draft only. There is no send tool.
- Unknown account aliases and missing token files return readable errors.
