import { getSandbox } from "../../src/sandbox/client.ts";
import { Sandbox as ShibaSandbox } from "../../src/sandbox.ts";
import { EXECUTION_EPOCH_LABEL } from "../../src/sandbox/execution-journal.ts";

export { SandboxOutbound } from "../../src/sandbox.ts";

export class Sandbox extends ShibaSandbox {
  async probeContainer() {
    await this.exposePort(80, { hostname: "fixture" });
    const container = this.ctx.container;
    const info = await container.inspect();
    const command = await container.exec(["sh", "-c", "printf 'sandbox started'"]);
    const { stdout, exitCode } = await command.output();
    return { stdout: new TextDecoder().decode(stdout), exitCode, epoch: info.labels[EXECUTION_EPOCH_LABEL] };
  }

  async cloneApprovedRepo() {
    await this.approveHarnessEgress(["github.com"]);
    await this.approveRepoScope("/octocat/Hello-World");
    const tls = await this.exec(
      `printf 'CA='; if test -s /etc/cloudflare/certs/cloudflare-containers-ca.crt; then echo present; else echo missing; fi; printf 'SSL_CERT_FILE=%s\\nCURL_CA_BUNDLE=%s\\nGIT_SSL_CAINFO=%s\\nGIT_SSL_NO_VERIFY=%s\\n' "$SSL_CERT_FILE" "$CURL_CA_BUNDLE" "$GIT_SSL_CAINFO" "$GIT_SSL_NO_VERIFY"; verify=$(git config --type=bool --get-urlmatch http.sslVerify https://github.com/octocat/Hello-World.git 2>/dev/null); result=$?; if [ "$result" -eq 1 ]; then verify=true; elif [ "$result" -ne 0 ]; then exit "$result"; fi; printf 'http.sslVerify=%s\\n' "$verify"`,
      { cwd: "/" },
    );
    try {
      await this.gitCheckout("https://github.com/octocat/Hello-World.git", {
        branch: "master",
        targetDir: "/workspace/Hello-World",
      });
    } catch (error) {
      return { tls, error: error.message };
    }
    const repo = await this.exec("git -C /workspace/Hello-World rev-parse HEAD && git -C /workspace/Hello-World status --short", { cwd: "/" });
    return { tls, repo };
  }
}

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.Sandbox, "sandbox-container-test");
    try {
      const result = new URL(request.url).pathname === "/clone"
        ? await sandbox.cloneApprovedRepo()
        : await sandbox.probeContainer();
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    } finally {
      await sandbox.destroy();
    }
  },
};
