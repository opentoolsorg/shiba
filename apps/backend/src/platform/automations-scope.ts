import type { Env } from "../env.js";
import { AUTOMATIONS_DO_NAME } from "../automation-runner.js";
import { automationsNameFor } from "./do-resolver.js";

export const AUTOMATION_WORKSPACE_HEADER = "X-Shiba-Automation-Workspace";
const REGISTRY_PREFIX = "automation-workspace:";
const WORKSPACE_KEY = "automation-workspace";
const RESTORE_PATH = "/internal/restore-workspace";
const SELF_HOSTED = "self-hosted";
const BROADCAST_PATHS = new Set([
  "/internal/tick",
  "/internal/github",
  "/internal/linear",
  "/internal/slack",
]);

export class AutomationsScope {
  workspaceId = SELF_HOSTED;
  private tickWork: Promise<Response> | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private stub(name: string) {
    return this.env.Automations.get(this.env.Automations.idFromName(name));
  }

  private async forward(request: Request, workspaceId: string): Promise<Response> {
    await this.ctx.storage.put(REGISTRY_PREFIX + workspaceId, workspaceId);
    const stub = this.stub(automationsNameFor(this.env, { workspaceId }));
    const entries =
      workspaceId === SELF_HOSTED
        ? [...(await this.ctx.storage.list()).entries()].filter(
            ([key]) => !key.startsWith(REGISTRY_PREFIX),
          )
        : [];
    const restored = await stub.fetch(
      new Request(`https://internal${RESTORE_PATH}`, {
        method: "POST",
        headers: { [AUTOMATION_WORKSPACE_HEADER]: workspaceId, "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      }),
    );
    if (!restored.ok) return restored;
    const headers = new Headers(request.headers);
    headers.set(AUTOMATION_WORKSPACE_HEADER, workspaceId);
    return stub.fetch(new Request(request, { headers }));
  }

  async fetch(request: Request, local: (request: Request) => Promise<Response>): Promise<Response> {
    if (this.env.SHIBA_SCOPED_DO !== "1") return local(request);
    const path = new URL(request.url).pathname;
    const root =
      this.ctx.id.toString() === this.env.Automations.idFromName(AUTOMATIONS_DO_NAME).toString();
    const selected = request.headers.get(AUTOMATION_WORKSPACE_HEADER);
    if (root) {
      if (path === RESTORE_PATH) return new Response(null, { status: 404 });
      if (path === "/internal/pr-owner" || path === "/internal/dedupe") return local(request);
      if (!selected && (BROADCAST_PATHS.has(path) || /\/webhook(?:\/|$)/.test(path))) {
        const registered = await this.ctx.storage.list<string>({ prefix: REGISTRY_PREFIX });
        const workspaces = new Set([SELF_HOSTED, ...registered.values()]);
        const body = request.body ? await request.arrayBuffer() : undefined;
        const responses = await Promise.all(
          [...workspaces].map((workspace) => this.forward(new Request(request.url, {
            method: request.method, headers: request.headers, body,
          }), workspace)),
        );
        if (/\/webhook(?:\/|$)/.test(path)) {
          return (
            responses.find((response) => response.ok) ??
            responses.find((response) => response.status >= 500) ??
            new Response(null, { status: 404 })
          );
        }
        if (responses.some((response) => !response.ok))
          return Response.json({ error: "Workspace dispatch failed." }, { status: 503 });
        return Response.json({ workspaces: workspaces.size });
      }
      return this.forward(request, selected ?? SELF_HOSTED);
    }
    if (
      !selected ||
      this.ctx.id.toString() !==
        this.env.Automations.idFromName(
          automationsNameFor(this.env, { workspaceId: selected }),
        ).toString()
    ) {
      return new Response(null, { status: 403 });
    }
    if (path === RESTORE_PATH && request.method === "POST") {
      const { entries } = (await request.json()) as { entries: [string, unknown][] };
      await this.ctx.storage.transaction(async (transaction) => {
        if (await transaction.get(WORKSPACE_KEY)) return;
        if (selected === SELF_HOSTED) {
          for (const [key, value] of entries) await transaction.put(key, value);
        }
        await transaction.put(WORKSPACE_KEY, selected);
      });
      return new Response(null, { status: 204 });
    }
    const workspace = await this.ctx.storage.get<string>(WORKSPACE_KEY);
    if (workspace !== selected) return new Response(null, { status: 503 });
    this.workspaceId = workspace;
    if (path !== "/internal/tick") return local(request);
    const prior = this.tickWork ?? Promise.resolve(new Response());
    const work = prior
      .catch(() => new Response())
      .then(async () => {
        const slot = request.headers.get("X-Shiba-Schedule-Slot");
        if (slot && (!/^\d+$/.test(slot) || !Number.isSafeInteger(Number(slot))))
          return new Response(null, { status: 400 });
        const lastSlot = await this.ctx.storage.get<string>("automation-tick-slot");
        if (slot && lastSlot && Number(lastSlot) >= Number(slot))
          return Response.json({ fired: 0 });
        const response = await local(request);
        if (slot && response.ok) await this.ctx.storage.put("automation-tick-slot", slot);
        return response;
      });
    this.tickWork = work;
    try {
      return await work;
    } finally {
      if (this.tickWork === work) this.tickWork = undefined;
    }
  }
}
