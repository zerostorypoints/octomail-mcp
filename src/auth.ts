import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { getAccountConfig } from "./config.js";
import { createOAuthClient, GMAIL_SCOPES } from "./gmail.js";

function parseArgs(argv: string[]): { account?: string } {
  const accountIndex = argv.indexOf("--account");
  if (accountIndex >= 0) {
    return { account: argv[accountIndex + 1] };
  }

  const inline = argv.find((arg) => arg.startsWith("--account="));
  if (inline) {
    return { account: inline.slice("--account=".length) };
  }

  return {};
}

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

async function main(): Promise<void> {
  const { account } = parseArgs(process.argv.slice(2));
  if (!account) {
    throw new Error("Missing --account. Example: npm run auth -- --account work");
  }

  const accountConfig = getAccountConfig(account);
  const { redirectUri, waitForCode } = await startCallbackServer();
  const oauth2Client = createOAuthClient(redirectUri);
  const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GMAIL_SCOPES],
  });

  console.log(`Open this URL in a browser to authorize account "${account}":\n`);
  console.log(authorizeUrl);
  console.log("\nWaiting for the browser callback...");

  const code = await waitForCode;
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.warn("Authorization succeeded, but Google did not return a refresh token.");
    console.warn("If this account was authorized before, revoke the app grant and run auth again.");
  }

  fs.mkdirSync(path.dirname(accountConfig.tokenPath), { recursive: true });
  fs.writeFileSync(accountConfig.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(accountConfig.tokenPath, 0o600);
  console.log(`Saved OAuth token for account "${account}" to ${accountConfig.tokenPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
