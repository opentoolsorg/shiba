import { redactSecrets } from "../security.js";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergePullInput {
  owner: string;
  repo: string;
  number: number;
  expectedHeadSha: string;
  mergeMethod?: MergeMethod;
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergePullDeps {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/** PUT /repos/{owner}/{repo}/pulls/{number}/merge — Worker-side only. */
export async function mergePullRequest(
  input: MergePullInput,
  token: string,
  deps: MergePullDeps = {},
): Promise<{ merged: boolean; sha?: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = (deps.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const path = `/repos/${input.owner}/${input.repo}/pulls/${input.number}/merge`;
  try {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "shiba",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sha: input.expectedHeadSha,
        merge_method: input.mergeMethod ?? "squash",
        ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
        ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub merge failed ${response.status}: ${text.slice(0, 300)}`);
    }
    const body = text ? JSON.parse(text) as { merged?: boolean; sha?: string } : {};
    return { merged: body.merged === true, sha: body.sha };
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}
