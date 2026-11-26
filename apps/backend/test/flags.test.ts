import { describe, expect, it, vi } from "vitest";
import { FLAGS, flag, flagStates, isFlagName } from "../src/config/flags.js";
import { handleAdminFlags } from "../src/config/flags-routes.js";
import type { Env } from "../src/env.js";

vi.mock("../src/team-member-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/team-member-auth.js")>(),
  isTeamDeploymentOperator: vi.fn(async () => true),
}));

describe("flag registry", () => {
  it("declares every flag with name, source, and description", () => {
    expect(FLAGS.length).toBeGreaterThan(30);
    const names = new Set<string>();
    for (const def of FLAGS) {
      expect(def.name).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(["var", "secret"]).toContain(def.source);
      expect(def.description.length).toBeGreaterThan(10);
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
    }
    expect(names.has("SHIBA_LOCAL_RUNTIME")).toBe(true);
    expect(names.has("INTERNAL_SIGNING_KEY")).toBe(true);
    expect(names.has("VAULT_KEYRING")).toBe(true);
  });

  it("flag() reads registered names and tolerates undefined env", () => {
    const env = { SHIBA_LOCAL_RUNTIME: "1", SHIBA_SANDBOX_PROVIDER: "docker-local" };
    expect(flag(env, "SHIBA_LOCAL_RUNTIME")).toBe("1");
    expect(flag(env, "SHIBA_SANDBOX_PROVIDER")).toBe("docker-local");
    expect(flag(env, "SHIBA_TEAM_MODEL_MODEL")).toBeUndefined();
    expect(flag(undefined, "SHIBA_LOCAL_RUNTIME")).toBeUndefined();
    expect(flag(null, "SHIBA_LOCAL_RUNTIME")).toBeUndefined();
    expect(flag({ SHIBA_LOCAL_RUNTIME: 42 }, "SHIBA_LOCAL_RUNTIME")).toBeUndefined();
  });

  it("isFlagName guards the registry", () => {
    expect(isFlagName("SHIBA_LOCAL_RUNTIME")).toBe(true);
    expect(isFlagName("SHIBA_NOPE")).toBe(false);
  });

  it("flagStates reports source, value, set — secrets never expose values", () => {
    const env = {
      SHIBA_LOCAL_RUNTIME: "1",
      SHIBA_DEV_OAUTH_LOOPBACK_SECRET: "super-secret-value",
      SHIBA_SANDBOX_PROVIDER: "",
    };
    const states = flagStates(env);
    expect(states).toHaveLength(FLAGS.length);
    const local = states.find((s) => s.name === "SHIBA_LOCAL_RUNTIME");
    expect(local).toMatchObject({ source: "var", value: "1", set: true });
    const secret = states.find((s) => s.name === "SHIBA_DEV_OAUTH_LOOPBACK_SECRET");
    expect(secret).toMatchObject({ source: "secret", value: null, set: true });
    expect(JSON.stringify(states)).not.toContain("super-secret-value");
    const provider = states.find((s) => s.name === "SHIBA_SANDBOX_PROVIDER");
    expect(provider).toMatchObject({ value: "", set: false, default: "cloudflare" });
    const unset = states.find((s) => s.name === "SHIBA_TEAM_MODEL_MODEL");
    expect(unset).toMatchObject({ value: null, set: false });
  });
});

describe("GET /api/admin/flags", () => {
  const env = { SHIBA_LOCAL_RUNTIME: "1" } as unknown as Env;

  it("returns the full registry for a deployment operator", async () => {
    const response = await handleAdminFlags(
      new Request("https://worker.test/api/admin/flags"),
      env,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { flags: { name: string; source: string; value: string | null; set: boolean }[] };
    expect(body.flags).toHaveLength(FLAGS.length);
    expect(body.flags.find((f) => f.name === "SHIBA_LOCAL_RUNTIME")).toMatchObject({
      source: "var",
      value: "1",
      set: true,
    });
  });

  it("ignores other paths", async () => {
    const response = await handleAdminFlags(
      new Request("https://worker.test/api/admin/other"),
      env,
    );
    expect(response).toBeNull();
  });

  it("rejects non-GET methods for operators", async () => {
    const response = await handleAdminFlags(
      new Request("https://worker.test/api/admin/flags", { method: "POST" }),
      env,
    );
    expect(response?.status).toBe(405);
  });
});
