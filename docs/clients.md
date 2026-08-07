# Connecting an MCP client

## Get the paths

Every client config below needs two absolute paths: the built server entry
point and your `accounts.json`. Rather than typing them by hand, run:

```bash
npm run setup -- --print-config
```

This prints ready-to-paste config blocks for Claude Code, Claude Desktop, and
Codex, filled in with the correct absolute paths for your checkout. The
sections below show what those blocks look like, with `/path/to/gmail-mcp` as
a stand-in for wherever you cloned this repository.

## Claude Code

```bash
claude mcp add gmail-multi --env GMAIL_MCP_ACCOUNTS_FILE=/path/to/gmail-mcp/accounts.json -- node /path/to/gmail-mcp/dist/server.js
```

## Claude Desktop

Add an entry under `mcpServers` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["/path/to/gmail-mcp/dist/server.js"],
      "env": {
        "GMAIL_MCP_ACCOUNTS_FILE": "/path/to/gmail-mcp/accounts.json"
      }
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.gmail_multi]
command = "node"
args = ["/path/to/gmail-mcp/dist/server.js"]
env = { GMAIL_MCP_ACCOUNTS_FILE = "/path/to/gmail-mcp/accounts.json" }
```

## After changing client config

Restart the client so it rediscovers the server — none of these clients watch
their config files for changes. If you've edited source since the last build,
run `npm run build` first, or the client will start the old `dist/`.

## Moving the checkout

All three configs above embed absolute paths to this repository. If you move
or rename the checkout directory, every client config that points at it
breaks. Re-run `npm run setup -- --print-config` and paste the new values into
each client.

## Example prompts

With aliases `work`, `personal`, and `support` configured:

```text
Search account personal for "from:alice@example.com newer_than:30d".
```

```text
Search all my accounts for "invoice newer_than:30d" and group the results by account.
```

```text
Read thread THREAD_ID from account work.
```

```text
Archive these message IDs in account support: ...
```
