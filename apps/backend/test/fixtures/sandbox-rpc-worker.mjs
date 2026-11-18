import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "../../src/sandbox/client.ts";

export class RpcSandbox extends DurableObject {
  name;
  calls = [];

  registerSandboxName(name) {
    if (name === "registration-error") throw new Error("registration refused");
    this.name = name;
    this.calls.push("register");
  }

  gitCheckout(repo, options) {
    this.calls.push("checkout");
    if (repo === "error") throw new Error("checkout refused");
    return { name: this.name, repo, options, calls: this.calls };
  }

  listProcesses() {
    return [];
  }
}

export default {
  async fetch(request, env) {
    const mode = new URL(request.url).pathname.slice(1);
    const name = mode === "registration-error" ? mode : "sandbox-rpc-test";
    const client = getSandbox(env.Sandbox, name);
    try {
      if (mode === "empty") return Response.json(await client.listProcesses());
      return Response.json(await client.gitCheckout(mode === "error" ? "error" : "https://example.com/repo.git", { branch: "main" }));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  },
};
