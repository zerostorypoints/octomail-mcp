import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { ensureAccount, setAccountEmail } from "./config.js";
import { createOAuthClient, GMAIL_SCOPES } from "./gmail.js";
import { google } from "googleapis";

export type AuthorizeResult = {
  alias: string;
  tokenPath: string;
  created: boolean;
  email?: string;
  hasRefreshToken: boolean;
};

async function startCallbackServer(): Promise<{
  redirectUri: string;
  waitForCode: Promise<string>;
}> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorization failed. You can close this tab.");
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
      server.close();
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing authorization code.");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Authorization complete. You can close this tab and return to the terminal.");
    resolveCode(code);
    server.close();
  });

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine OAuth callback port."));
        server.close();
        return;
      }

      resolve(`http://127.0.0.1:${address.port}/oauth2callback`);
    });
  });

  return { redirectUri, waitForCode };
}

function tryOpenBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening a browser is a convenience. The URL is always printed as well.
  }
}

export async function authorizeAccount(
  alias: string,
  options: { label?: string; openBrowser?: boolean } = {},
): Promise<AuthorizeResult> {
  const { config, created } = ensureAccount(alias, options.label);
  if (created) {
    console.log(`Added new account alias "${alias}" to accounts.json.`);
  }

  const { redirectUri, waitForCode } = await startCallbackServer();
  const oauth2Client = createOAuthClient(redirectUri);
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
  });

  console.log(`\nAuthorize account "${alias}" in your browser:\n`);
  console.log(authorizeUrl);
  console.log("\nWaiting for the browser callback...");

  if (options.openBrowser !== false) {
    tryOpenBrowser(authorizeUrl);
  }

  const code = await waitForCode;
  const { tokens } = await oauth2Client.getToken(code);
  const hasRefreshToken = Boolean(tokens.refresh_token);

  if (!hasRefreshToken) {
    console.warn("Authorization succeeded, but Google did not return a refresh token.");
    console.warn("If this account was authorized before, revoke the app grant and run auth again.");
  }

  fs.mkdirSync(path.dirname(config.tokenPath), { recursive: true });
  fs.writeFileSync(config.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(config.tokenPath, 0o600);

  let email: string | undefined;
  try {
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    email = profile.data.emailAddress ?? undefined;
    if (email) {
      setAccountEmail(alias, email);
    }
  } catch {
    // The token is already saved. A failed profile lookup only costs the stored email.
  }

  console.log(`Saved OAuth token for "${alias}"${email ? ` (${email})` : ""} to ${config.tokenPath}.`);

  return { alias, tokenPath: config.tokenPath, created, email, hasRefreshToken };
}
