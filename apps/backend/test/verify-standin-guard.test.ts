import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isLoopbackMockGithub, verifyStandinEnabled } from "../../../packages/shared/src/verify-standin.js";
import { describe, expect, it } from "vitest";

describe("verifyStandinEnabled guard", () => {
  it("enables only with the flag AND an explicit loopback mock GitHub", () => {
    for (const base of [
      "http://127.0.0.1:8799",
      "http://localhost:8799/",
      "http://[::1]:8799",
    ]) {
      expect(verifyStandinEnabled({ SHIBA_VERIFY_STANDIN: "1", GITHUB_API_BASE: base })).toBe(true);
    }
  });

  it("fails closed for live, missing, or non-loopback GitHub", () => {
    for (const base of [
      undefined,
      "",
      "https://api.github.com",
      "https://127.0.0.1:8799",
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      "http://0.0.0.0:8799",
      "http://user:pw@127.0.0.1:8799",
      "not a url",
    ]) {
      expect(verifyStandinEnabled({ SHIBA_VERIFY_STANDIN: "1", GITHUB_API_BASE: base })).toBe(
        false,
      );
    }
  });

  it("stays off without the flag even for a loopback mock", () => {
    expect(verifyStandinEnabled({ GITHUB_API_BASE: "http://127.0.0.1:8799" })).toBe(false);
    expect(
      verifyStandinEnabled({ SHIBA_VERIFY_STANDIN: "0", GITHUB_API_BASE: "http://127.0.0.1:8799" }),
    ).toBe(false);
    expect(isLoopbackMockGithub(undefined)).toBe(false);
  });
});

const LAUNCH = resolve(__dirname, "../../../.cursor/skills/verify-shiba/scripts/launch.sh");
const OPERATOR_SIGNING_KEY = "operator-fixture-signing-key";
const OPERATOR_TYPESAFE_KEY = "operator-fixture-typesafe-key";

type Plan = {
  status: number | null;
  stdout: string;
  stderr: string;
  file: (name: string) => string;
  env: Map<string, string>;
  envMode: number | undefined;
};

function plan(opts: {
  docker: "ok" | "fail";
  vars: Record<string, string | undefined>;
  existingPublicEnv?: boolean;
}): Plan {
  const dir = mkdtempSync(join(tmpdir(), "verify-launch-"));
  const verifyDir = join(dir, "verify");
  const devVars = join(dir, "dev.vars");
  // Fake docker so the test never depends on a real daemon.
  writeFileSync(join(dir, "docker"), `#!/bin/sh\nexit ${opts.docker === "ok" ? 0 : 1}\n`);
  chmodSync(join(dir, "docker"), 0o755);
  writeFileSync(
    devVars,
    "GITHUB_TOKEN=real-live-token\nGITHUB_API_BASE=http://127.0.0.1:1\nSHIBA_VERIFY_STANDIN=1\nOTHER=keep\n" +
      `INTERNAL_SIGNING_KEY=${OPERATOR_SIGNING_KEY}\nMEMORY_ENABLED=true\nTYPESAFE_API_KEY=${OPERATOR_TYPESAFE_KEY}\n`,
  );
  if (opts.existingPublicEnv) {
    mkdirSync(verifyDir);
    writeFileSync(join(verifyDir, "run.env"), "stale public file\n", { mode: 0o644 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    VERIFY_DIR: verifyDir,
    VERIFY_DEV_VARS: devVars,
    VERIFY_PLAN_ONLY: "1",
  };
  for (const [k, v] of Object.entries(opts.vars)) if (v !== undefined) env[k] = v;
  const res = spawnSync("bash", [LAUNCH], { env, encoding: "utf8" });
  const file = (name: string) => {
    try {
      return readFileSync(join(verifyDir, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const parsed = new Map<string, string>();
  for (const line of file("run.env").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) parsed.set(line.slice(0, i), line.slice(i + 1));
  }
  // .dev.vars must never be rewritten by the launcher.
  expect(readFileSync(devVars, "utf8")).toContain("real-live-token");
  expect(readFileSync(devVars, "utf8")).toContain(OPERATOR_SIGNING_KEY);
  let envMode: number | undefined;
  try {
    envMode = statSync(join(verifyDir, "run.env")).mode & 0o777;
  } catch {
    // Refused modes exit before generating an environment file.
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, file, env: parsed, envMode };
}

describe("launch.sh effective mode", () => {
  it("mock GitHub + no containers: stand-in on, stale flags overridden, loopback base", () => {
    const p = plan({ docker: "fail", vars: { VERIFY_GITHUB: "mock", GITHUB_STUB_PORT: "8799" } });
    expect(p.status).toBe(0);
    expect(p.file("containers-mode")).toBe("containers=disabled (no docker)");
    expect(p.file("standin-mode")).toBe("enabled");
    expect(p.env.get("SHIBA_VERIFY_STANDIN")).toBe("1");
    expect(p.env.get("GITHUB_API_BASE")).toBe("http://127.0.0.1:8799");
    expect(p.env.get("GITHUB_TOKEN")).toBe("mock-github-token");
    expect(p.env.get("OTHER")).toBe("keep");
    expect(p.env.get("INTERNAL_SIGNING_KEY")).toMatch(/^[a-f0-9]{64}$/);
    expect(p.env.get("MEMORY_ENABLED")).toBe("0");
    expect(p.env.get("TYPESAFE_API_KEY")).toBe("");
    expect(p.file("run.env")).not.toContain(OPERATOR_SIGNING_KEY);
    expect(p.file("run.env")).not.toContain(OPERATOR_TYPESAFE_KEY);
    expect(p.envMode).toBe(0o600);
  });

  it("mints a new private Worker signing key on every stand-in launch without logging it", () => {
    const first = plan({ docker: "fail", vars: { VERIFY_GITHUB: "mock" }, existingPublicEnv: true });
    const second = plan({ docker: "fail", vars: { VERIFY_GITHUB: "mock" } });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstKey = first.env.get("INTERNAL_SIGNING_KEY");
    const secondKey = second.env.get("INTERNAL_SIGNING_KEY");
    expect(firstKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondKey).toMatch(/^[a-f0-9]{64}$/);
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).not.toBe(OPERATOR_SIGNING_KEY);
    expect(secondKey).not.toBe(OPERATOR_SIGNING_KEY);
    for (const p of [first, second]) {
      expect(p.envMode).toBe(0o600);
      expect(p.stdout + p.stderr).not.toContain(p.env.get("INTERNAL_SIGNING_KEY"));
      expect(p.stdout + p.stderr).not.toContain(OPERATOR_SIGNING_KEY);
      expect(p.stdout + p.stderr).not.toContain(OPERATOR_TYPESAFE_KEY);
    }
  });

  it("real containers + mock GitHub: stand-in forced off despite a stale persistent flag", () => {
    const p = plan({
      docker: "ok",
      vars: { VERIFY_GITHUB: "mock", VERIFY_ENABLE_CONTAINERS: "1", GITHUB_STUB_PORT: "8799" },
    });
    expect(p.status).toBe(0);
    expect(p.file("containers-mode")).toBe("containers=enabled");
    expect(p.file("standin-mode")).toBe("disabled");
    expect(p.env.get("SHIBA_VERIFY_STANDIN")).toBe("0");
    expect(p.env.get("INTERNAL_SIGNING_KEY")).toBe(OPERATOR_SIGNING_KEY);
    expect(p.env.get("MEMORY_ENABLED")).toBe("true");
    expect(p.env.get("TYPESAFE_API_KEY")).toBe(OPERATOR_TYPESAFE_KEY);
  });

  it("live GitHub: stale stand-in flag and mock base are dropped, real token kept", () => {
    const p = plan({ docker: "fail", vars: { VERIFY_GITHUB: "live" } });
    expect(p.status).toBe(0);
    expect(p.file("github-mode")).toBe("live");
    expect(p.file("standin-mode")).toBe("disabled");
    expect(p.env.get("SHIBA_VERIFY_STANDIN")).toBe("0");
    expect(p.env.has("GITHUB_API_BASE")).toBe(false);
    expect(p.env.get("GITHUB_TOKEN")).toBe("real-live-token");
    expect(p.env.get("INTERNAL_SIGNING_KEY")).toBe(OPERATOR_SIGNING_KEY);
    expect(p.env.get("MEMORY_ENABLED")).toBe("true");
    expect(p.env.get("TYPESAFE_API_KEY")).toBe(OPERATOR_TYPESAFE_KEY);
  });

  it("explicit containers requested but Docker unavailable: fails, no stand-in", () => {
    const p = plan({ docker: "fail", vars: { VERIFY_GITHUB: "mock", VERIFY_ENABLE_CONTAINERS: "1" } });
    expect(p.status).toBe(1);
    expect(p.stderr).toContain("Docker is unavailable");
    expect(p.file("standin-mode")).toBe("disabled");
    expect(p.file("containers-mode")).toMatch(/^unavailable/);
  });

  it("CI path: containers disabled, stand-in on, wrangler flags unchanged", () => {
    const p = plan({ docker: "ok", vars: { VERIFY_GITHUB: "mock", CI: "true" } });
    expect(p.status).toBe(0);
    expect(p.file("containers-mode")).toBe("disabled");
    expect(p.file("standin-mode")).toBe("enabled");
    expect(p.env.get("INTERNAL_SIGNING_KEY")).toMatch(/^[a-f0-9]{64}$/);
    expect(p.env.get("MEMORY_ENABLED")).toBe("0");
    expect(p.env.get("TYPESAFE_API_KEY")).toBe("");
  });
});
