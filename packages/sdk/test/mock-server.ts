import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

export interface MockShibaOptions {
  routes?: RouteHandler;
}

export async function startMockShiba(options: MockShibaOptions = {}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  setHandler: (handler: RouteHandler) => void;
}> {
  let handler = options.routes ?? defaultHandler;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    setHandler: (next) => {
      handler = next;
    },
  };
}

function defaultHandler(req: IncomingMessage, res: ServerResponse, body: string): void {
  const auth = req.headers.authorization ?? "";
  if (!auth.includes("shk_test")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/v1/threads" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ threads: [{ threadId: "t1", title: "Demo", status: "completed" }] }));
    return;
  }
  if (url.pathname === "/api/v1/threads" && req.method === "POST") {
    const parsed = JSON.parse(body) as { requestId?: string };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ approvalId: "a1", id: "a1", requestId: parsed.requestId, status: "waiting" }));
    return;
  }
  if (url.pathname === "/api/v1/threads/t1/stream" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("id: 1\ndata: {\"id\":\"evt_1\",\"type\":\"run.completed\",\"cursor\":\"1\"}\n\n");
    res.end();
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}
