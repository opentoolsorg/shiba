import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SHARED_COMPUTER_LIMITS } from "@shiba/shared";
import { computerPolicy } from "../src/shared-computer-store.js";

const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
describe("dedicated offline desktop image and approved bounds", () => {
  it("pins the exact base/shim digests and a package snapshot without copying build trust or credentials", () => {
    const docker = file("../Dockerfile.computer");
    expect(docker).toContain("debian:bookworm-slim@sha256:a3bba7dc7dbcc1f37c2856c51fc9a7fac96608f50cb87b1b4e4d8b8c85ae988e");
    expect(docker).toContain("sandbox:1.0.1@sha256:e796e813de8213fb062bba279ddeddbf61277389a2cc7b3e4620075a9188843b");
    expect(docker).toContain("snapshot.debian.org/archive/debian/20261105T000000Z");
    expect(docker).toContain("--mount=type=secret,id=proxy_ca");
    expect(docker).not.toMatch(/COPY[^\n]*(?:proxy_ca|auth\.json|\.env|\.ssh)|ENV[^\n]*(?:TOKEN|SECRET|API_KEY)|^EXPOSE\s/m);
    expect(docker).not.toMatch(/apt-get[^\n]*(?:allow-unauthenticated|Verify-Peer=false)|curl[^\n]*-k/);
    expect(docker).toContain("packages.tsv"); expect(docker).toContain("/usr/share/doc/$p/copyright");
    expect(docker).toContain("computer/NOTICE computer/LICENSE-sandbox");
    expect(file("../computer/LICENSE-sandbox")).toContain("Apache License");
  });
  it("has no coding harness, host access, public desktop listener or remote download at runtime", () => {
    const entry = file("../computer/entrypoint.sh"), html = file("../computer/desktop.html");
    expect(entry).toContain("-nolisten tcp"); expect(entry).toContain("--disable-quic"); expect(entry).toContain("file:///opt/shiba-computer/desktop.html");
    expect(entry).not.toMatch(/(?:\bcurl\b|\bwget\b|\bnpm\b|\bclaude\b|\bcodex\b|x11vnc|websockify|remote-debugging-port)/);
    expect(html).toContain("default-src 'none'"); expect(html).toContain("form-action 'none'"); expect(html).not.toMatch(/<script|https?:\/\//);
  });
  it("enforces a fixed local watchdog and refuses missing, expired or over-limit expiry", () => {
    const entry = file("../computer/entrypoint.sh"); expect(entry).toContain('"$remaining_ms" -gt 0'); expect(entry).toContain('"$remaining_ms" -le 600000');
    expect(entry).toContain('wait "$watchdog"'); expect(SHARED_COMPUTER_LIMITS.ttlMs).toBe(600000); expect(SHARED_COMPUTER_LIMITS.leaseMs).toBe(60000);
  });
  it("reports unavailable rather than silently selecting an image/runtime", () => {
    const env = { SHIBA_SHARED_COMPUTER: "1", ComputerSession: {}, INTERNAL_SIGNING_KEY: "fixture-only-internal-control-key-20261105" };
    expect(computerPolicy(env as never)).toMatchObject({ available: false, reason: "shared_computer_image_unavailable" });
    expect(computerPolicy({ ...env, SHIBA_SHARED_COMPUTER_IMAGE: "image:latest" } as never).available).toBe(false);
    expect(computerPolicy({ ...env, SHIBA_SHARED_COMPUTER_IMAGE: `image@sha256:${"a".repeat(64)}` } as never).available).toBe(true);
  });
});
