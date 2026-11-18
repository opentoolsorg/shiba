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
}

export default {
  async fetch(_request, env) {
    const sandbox = getSandbox(env.Sandbox, "sandbox-container-test");
    try {
      return Response.json(await sandbox.probeContainer());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    } finally {
      await sandbox.destroy();
    }
  },
};
