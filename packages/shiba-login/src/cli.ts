#!/usr/bin/env node
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beginSignIn, parseListenTarget, postComplete } from "./lib.js";

const execFileAsync = promisify(execFile);

function usage(): string {
  return `shiba-login — post ChatGPT SIWC callback to shiba

Usage:
  shiba-login --base-url <url> [--callback-url <url>]
  shiba-login --base-url <url> [--authorize-url <url> --redirect-uri <uri>]
  shiba-login --base-url <url>   # calls /begin, opens browser, listens on redirect URI

Auth (one of):
  --cookie <Cookie header value>
  SHIBA_SESSION_COOKIE env var

Options:
  --no-open   Do not launch a browser for the authorize URL
`;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function authHeaders(): Record<string, string> {
  const cookie = readArg("--cookie") ?? process.env.SHIBA_SESSION_COOKIE;
  if (!cookie) {
    throw new Error("Session cookie required — pass --cookie or set SHIBA_SESSION_COOKIE.");
  }
  return { cookie };
}

async function listenForCallback(redirectUri: string): Promise<string> {
  const { host, port, pathname } = parseListenTarget(redirectUri);
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      const incoming = new URL(req.url, `http://${host}:${port}`);
      if (incoming.pathname !== pathname) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const callbackUrl = `http://${host}:${port}${incoming.pathname}${incoming.search}`;
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("Signed in — you can close this tab and return to shiba.");
      server.close();
      resolve(callbackUrl);
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      process.stderr.write(`Listening on http://${host}:${port}${pathname}\n`);
    });
  });
}

function assertHttpBrowserUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("authorizeUrl is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("authorizeUrl must use http or https.");
  }
  return parsed.href;
}

async function maybeOpenBrowser(url: string): Promise<void> {
  if (process.argv.includes("--no-open")) return;
  const href = assertHttpBrowserUrl(url);
  const platform = process.platform;
  if (platform === "win32") {
    // Avoid cmd.exe — a backend-controlled URL must not pass through a shell.
    await execFileAsync("rundll32", ["url.dll,FileProtocolHandler", href]).catch(() => undefined);
    return;
  }
  const command = platform === "darwin" ? "open" : "xdg-open";
  await execFileAsync(command, [href]).catch(() => undefined);
}

async function main(): Promise<void> {
  const baseUrl = readArg("--base-url") ?? process.env.SHIBA_BASE_URL;
  if (!baseUrl) {
    process.stderr.write(usage());
    process.exit(1);
  }
  const headers = authHeaders();
  const callbackUrlArg = readArg("--callback-url");
  if (callbackUrlArg) {
    const result = await postComplete(baseUrl, callbackUrlArg, headers);
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  let authorizeUrl = readArg("--authorize-url");
  let redirectUri = readArg("--redirect-uri");
  if (!authorizeUrl || !redirectUri) {
    const begin = await beginSignIn(baseUrl, headers);
    authorizeUrl = begin.authorizeUrl;
    redirectUri = begin.redirectUri;
  }
  await maybeOpenBrowser(authorizeUrl);
  const callbackUrl = await listenForCallback(redirectUri);
  const result = await postComplete(baseUrl, callbackUrl, headers);
  process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
