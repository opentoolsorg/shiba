import { describe, expect, it, vi } from "vitest";
import { createDockerLocalSandboxProvider, type DockerExecutor } from "../src/adapters/docker-local.js";
import { describeSandboxProviderContract } from "../src/contract-suite.js";

function mockDocker(): DockerExecutor {
  const running = new Map<string, string>();
  const files = new Map<string, string>();
  return {
    async run(args) {
      if (args[0] === "inspect") {
        const name = args[args.length - 1]!;
        const instanceId = running.get(name);
        if (instanceId === undefined) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: `true|${instanceId}`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "run") {
        const nameIdx = args.indexOf("--name");
        const name = nameIdx >= 0 ? args[nameIdx + 1]! : "unknown";
        const labelIdx = args.findIndex((arg) => arg.startsWith("shiba.instance_id="));
        const instanceId = labelIdx >= 0 ? args[labelIdx]!.slice("shiba.instance_id=".length) : name;
        running.set(name, instanceId);
        return { stdout: "cid\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "exec") {
        const container = args[args.indexOf("sh") - 1]!;
        const scriptIdx = args.indexOf("-c");
        const script = scriptIdx >= 0 ? args[scriptIdx + 1]! : "";
        if (script.includes("base64 -d")) {
          const pathMatch = script.match(/>\s+'([^']+)'/);
          const encMatch = script.match(/echo\s+'([^']+)'/);
          if (pathMatch && encMatch) {
            files.set(pathMatch[1]!, atob(encMatch[1]!));
          }
        } else if (script.includes("base64 '/tmp/shiba-contract.txt'")) {
          const content = files.get("/tmp/shiba-contract.txt") ?? "";
          return { stdout: btoa(content), stderr: "", exitCode: 0 };
        } else if (script.includes("echo contract-ok")) {
          return { stdout: "contract-ok\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "rm") {
        const name = args[args.length - 1]!;
        running.delete(name);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describeSandboxProviderContract("docker-local (mock docker)", () =>
  createDockerLocalSandboxProvider({
    image: "shiba-sandbox:mock",
    dockerExec: mockDocker(),
  }),
);

it("reuses a running container with the matching instance label", async () => {
  const docker = mockDocker();
  const run = vi.spyOn(docker, "run");
  const provider = createDockerLocalSandboxProvider({ image: "shiba-sandbox:mock", dockerExec: docker });
  const instance = await provider.get("label-reuse-test");
  await instance.exec("echo contract-ok");
  await instance.exec("echo contract-ok");
  expect(run.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(1);
  expect(run.mock.calls.filter(([args]) => args[0] === "rm")).toHaveLength(0);
});
