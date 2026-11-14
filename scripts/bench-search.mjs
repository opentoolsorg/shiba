// Times GET /api/search from the Server-Timing search;dur value.
// Pass the session cookie in SHIBA_SESSION_COOKIE. Do not commit that value.

const url = process.env.SHIBA_SEARCH_URL ?? "http://127.0.0.1:8788/api/search";
const cookie = process.env.SHIBA_SESSION_COOKIE ?? "";
const workspace = process.env.SHIBA_WORKSPACE_ID ?? "";
const query = process.env.SHIBA_SEARCH_Q ?? "readme";
const samples = Math.max(1, Math.min(200, Number(process.env.SHIBA_SEARCH_N ?? 50)));

if (!cookie || !workspace) {
  console.error("SHIBA_SESSION_COOKIE and SHIBA_WORKSPACE_ID are required. Keep the cookie out of the repo.");
  process.exit(1);
}

const durations = [];
for (let index = 0; index < samples; index += 1) {
  const target = new URL(url);
  target.searchParams.set("q", query);
  target.searchParams.set("types", "chats,tasks");
  const response = await fetch(target, {
    headers: { cookie, "X-Shiba-Workspace": workspace },
  });
  const timing = response.headers.get("server-timing") ?? "";
  const match = /search;dur=([0-9.]+)/.exec(timing);
  if (!response.ok || !match) {
    console.error(`search failed (${response.status}) timing=${timing || "missing"}`);
    process.exit(1);
  }
  durations.push(Number(match[1]));
}

durations.sort((a, b) => a - b);
const at = (ratio) => durations[Math.min(durations.length - 1, Math.max(0, Math.ceil(ratio * durations.length) - 1))];
console.log(JSON.stringify({ n: durations.length, p50: at(0.5), p95: at(0.95) }));
