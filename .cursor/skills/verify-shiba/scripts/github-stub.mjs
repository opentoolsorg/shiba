#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8799);
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const calls = [];
const reviews = [];
const pulls = new Map();

function save() {
  mkdirSync(join(root, ".verify"), { recursive: true });
  writeFileSync(join(root, ".verify", "github-stub-calls.json"), JSON.stringify(calls, null, 2));
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, body: body.slice(0, 4000) });
    save();
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "/";
    if (req.method === "POST" && /\/pulls\/\d+\/reviews$/.test(url)) {
      const review = { id: reviews.length + 1, html_url: "https://github.com/mock/repo/pull/1#review-1", body, state: "COMMENTED" };
      reviews.push(review);
      res.end(JSON.stringify(review));
      return;
    }
    if (req.method === "GET" && /\/pulls\/\d+\/reviews$/.test(url)) {
      res.end(JSON.stringify(reviews.map((review) => ({ ...review, body: review.body }))));
      return;
    }
    if (req.method === "POST" && /\/pulls$/.test(url)) {
      const pull = { node_id: "PR_1", number: 1, html_url: "https://github.com/mock/repo/pull/1", state: "open", merged: false, title: "mock", body: "", mergeable: true, head: { ref: "shiba/x", sha: "abc123" }, base: { ref: "main" } };
      pulls.set(1, pull);
      res.end(JSON.stringify(pull));
      return;
    }
    if (req.method === "GET" && /\/pulls\/\d+$/.test(url)) {
      res.end(JSON.stringify(pulls.get(1) ?? { node_id: "PR_1", number: 1, html_url: "https://github.com/mock/repo/pull/1", state: "open", merged: false, title: "mock", body: "", mergeable: true, head: { ref: "shiba/x", sha: "abc123" }, base: { ref: "main" } }));
      return;
    }
    if (url.includes("/check-runs")) { res.end(JSON.stringify({ check_runs: [] })); return; }
    if (url.includes("/comments")) { res.end(JSON.stringify([])); return; }
    if (url.includes("/git/ref/")) { res.end(JSON.stringify({ object: { sha: "basebase" } })); return; }
    res.end(JSON.stringify({ ok: true, sha: "abc123" }));
  });
});
server.listen(port, "127.0.0.1", () => console.log(`github-stub ${port}`));
