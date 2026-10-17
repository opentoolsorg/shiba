import type { V1Context } from "./context.js";

interface GitHubRepo {
  id: number; full_name: string; default_branch: string; private: boolean; clone_url: string; language: string | null;
}

const API = "https://api.github.com";
// A PAT has no App installation; it surfaces as one pseudo-installation for the token's account.
const PAT_INSTALLATION = "pat";

// Dependency -> framework name + its default dev-server port; first hit wins, so meta-frameworks precede vite.
const FRAMEWORKS: Array<[string, string, number]> = [
  ["next", "nextjs", 3000], ["nuxt", "nuxt", 3000], ["@remix-run/dev", "remix", 3000], ["astro", "astro", 4321],
  ["@sveltejs/kit", "sveltekit", 5173], ["@angular/core", "angular", 4200], ["vite", "vite", 5173],
  ["react-scripts", "create-react-app", 3000],
];

async function github<T>(ctx: V1Context, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
      "User-Agent": "shiba", "X-GitHub-Api-Version": "2022-11-28" } });
  // Upstream bodies can echo request detail; only the status crosses the boundary.
  if (!response.ok) throw new Error(`github_${response.status}`);
  return await response.json() as T;
}

// Numeric ids use GitHub's id-addressed routes; `owner/repo` (encoded as one segment) is accepted too.
function repoBase(id: string): string | null {
  if (/^\d+$/.test(id)) return `/repositories/${id}`;
  const match = id.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? `/repos/${match[1]}/${match[2]}` : null;
}

function inspectPackage(raw: string | null) {
  if (raw === null) return { framework: null, settings: { path: ".", previewPort: null, invalid: false, scripts: {} } };
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; packageManager?: string };
  try { pkg = JSON.parse(raw); if (!pkg || typeof pkg !== "object") throw new Error(); }
  catch { return { framework: null, settings: { path: ".", previewPort: null, invalid: true, scripts: {} } }; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hit = FRAMEWORKS.find(([dep]) => dep in deps);
  const pm = pkg.packageManager?.match(/^(pnpm|yarn|bun|npm)@/)?.[1] ?? "npm";
  return { framework: hit?.[1] ?? null, settings: { path: ".", previewPort: hit?.[2] ?? null, invalid: false, scripts: {
    setup: { enabled: true, command: `${pm} install` },
    run: typeof pkg.scripts?.dev === "string" ? { enabled: true, command: `${pm} run dev` } : { enabled: false, command: null },
    archive: { enabled: false, command: null },
  } } };
}

export async function handleRepositories(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/source-control\/github\/(installations|repositories)(?:\/([^/]+)\/(branches|inspect))?$/);
  if (!match || (match[1] === "installations" && match[2])) return null;
  if (ctx.request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let base: string | null = null;
  if (match[2]) {
    try { base = repoBase(decodeURIComponent(match[2])); } catch { /* falls through to 400 */ }
    if (!base) return Response.json({ ok: false, error: "invalid_repository" }, { status: 400 });
  }
  if (!ctx.env.GITHUB_TOKEN) return Response.json({ ok: false, error: "github_not_configured" }, { status: 503 });
  try {
    if (match[3] === "branches") {
      // One page of 100; GitHub caps per_page there.
      const branches = await github<Array<{ name: string }>>(ctx, `${base}/branches?per_page=100`);
      return Response.json({ ok: true, branches: branches.map((branch) => branch.name) });
    }
    if (match[3] === "inspect") {
      const [, file] = await Promise.all([
        github<GitHubRepo>(ctx, base!),
        github<{ content?: string }>(ctx, `${base}/contents/package.json`).catch((error: unknown) => {
          if (error instanceof Error && error.message === "github_404") return null;
          throw error;
        }),
      ]);
      const raw = file?.content === undefined ? null
        : new TextDecoder().decode(Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)));
      return Response.json({ ok: true, inspection: inspectPackage(raw) });
    }
    const reposPath = "/user/repos?per_page=100&sort=updated";
    if (match[1] === "repositories") {
      const repos = await github<GitHubRepo[]>(ctx, reposPath);
      return Response.json({ ok: true, repositories: repos.map((repo) => ({ id: String(repo.id), fullName: repo.full_name,
        defaultBranch: repo.default_branch, private: repo.private })) });
    }
    const [user, repos] = await Promise.all([github<{ login: string; type: string }>(ctx, "/user"), github<GitHubRepo[]>(ctx, reposPath)]);
    return Response.json({ ok: true, installations: [{ id: PAT_INSTALLATION, installationId: 0, apiBaseUrl: API,
      accountLogin: user.login, accountType: user.type,
      repositories: repos.map((repo) => ({ id: String(repo.id), installationId: PAT_INSTALLATION, repositoryId: repo.id,
        fullName: repo.full_name, apiBaseUrl: API, cloneUrl: repo.clone_url, language: repo.language, framework: null,
        defaultBranch: repo.default_branch, private: repo.private })) }] });
  } catch (error) {
    const status = Number((error instanceof Error ? error.message : "").replace("github_", ""));
    return Response.json({ ok: false, error: "github_request_failed" }, { status: status === 404 ? 404 : 502 });
  }
}
