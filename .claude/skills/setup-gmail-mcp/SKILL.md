---
name: setup-gmail-mcp
description: Use when setting up or troubleshooting this Gmail MCP server — configuring OAuth credentials, authorizing Gmail accounts, verifying they work, or registering the server with an MCP client.
---

# Setting up Gmail MCP

This server exposes several Gmail accounts to an MCP client, each addressed by
an alias. Setting it up means: OAuth credentials once, then one authorization
per account, then registering the server with the client.

## Important: you have no TTY

`npm run setup` with no arguments prompts interactively and will refuse to run
without a terminal. Always drive it with flags instead.

## Steps

1. **Check the current state first.**

   ```bash
   npm run doctor
   ```

   Read the output before doing anything. It reports Node version, whether the
   build is current, whether OAuth credentials resolve, and for each configured
   account either `✓ alias → address` or a `✗` line containing the exact command
   that fixes it. A `!` line may also appear alongside either one, warning that a
   token file's permissions are wrong. If everything is `✓`, there is nothing to do.

2. **If OAuth credentials are missing**, do not try to create them yourself.
   Tell the user to follow `docs/google-cloud-setup.md`, and stress the
   publishing-status point: a Testing-status app expires refresh tokens after
   7 days.

   Do not ask the user to paste the client secret into the chat, and do not
   write it yourself. Direct them to put it in `.env` themselves:

   ```bash
   npm run setup
   ```

   Run from their own terminal, that prompts for the client ID and secret and
   writes `.env` at mode `0600` without the value ever passing through you.
   Alternatively they can create `.env` by hand from `.env.example`. Once they
   confirm it exists, continue at step 3.

3. **Authorize each account the user names.** One command per account:

   ```bash
   npm run auth -- --account work --label "Work Mail"
   ```

   This prints a Google URL and blocks until the user completes the browser
   flow. Surface the URL to the user and wait. The alias is added to
   `accounts.json` automatically — never hand-edit that file to add an account.
   Run this in the background or with a generous timeout, since it waits on a
   human.

   **Never attempt the consent screen yourself**, including with browser
   automation. It requires the user's own signed-in Google session, and
   completing an OAuth grant is the user's decision to make, not yours.

4. **Verify.**

   ```bash
   npm run doctor
   ```

   Every account the user asked for should now be `✓`. If one is still `✗`,
   read the message and consult `docs/troubleshooting.md` — do not guess.

5. **Register the server with the client.**

   ```bash
   npm run setup -- --print-config
   ```

   This prints correct absolute paths for Claude Code, Claude Desktop, and
   Codex. For Claude Code, run the printed `claude mcp add` command. For the
   other two, give the user the block to paste and tell them to restart the
   client.

## Rules

- Never write, read back, or echo OAuth tokens, client secrets, or the contents
  of files under the token directory.
- Never add an account by editing `accounts.json` directly; use `npm run auth`.
- If `npm run doctor` says the build is stale, run `npm run build` before
  drawing any other conclusion.
