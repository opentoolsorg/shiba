/** Local test entry only. It is never imported by the production Worker. */
import { ConversationRoom } from "../../src/conversation-room-do.js";
import { createRunJournalPublisher } from "../../src/run-journal-publisher.js";
import { runRoomName, MAX_RUN_ROOM_EVENTS, type RunJournalBatch } from "../../src/run-room-events.js";
import type { JournalFrame } from "@shiba/sandbox";
import type { Env } from "../../src/env.js";
export { ConversationRoom };

type FixtureEnv = Env & { FIXTURE_JOB: string };
const identity = (retention = false) => ({ ownerId: "journal-fixture@example.test", sessionId: retention ? "11111111-1111-4111-8111-111111111111" : "default", runId: retention ? "retention-fixture" : "recovery-fixture" });
const journal = (env: FixtureEnv, retention = false) => ({ jobId: retention ? "9".repeat(64) : env.FIXTURE_JOB, generation: "b".repeat(64) });
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url), retaining = url.searchParams.get("retention") === "1";
    const who = identity(retaining), source = journal(env, retaining);
    const room = env.ConversationRoom.getByName(runRoomName(who.ownerId, who.sessionId));
    if (url.pathname === "/socket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return room.fetch(new Request("http://fixture.internal/socket", { headers: {
        Upgrade: "websocket", "x-shiba-room-owner": who.ownerId, "x-shiba-room-actor": who.ownerId,
        "x-shiba-room-session": who.sessionId, "x-shiba-room-viewer": "22222222-2222-4222-8222-222222222222", "x-shiba-room-readonly": "true", "x-shiba-room-run": who.runId,
      } }));
    }
    if (url.pathname === "/ack") return Response.json({ acknowledged: await room.openRunJournal(who, source) });
    if (url.pathname === "/replay") return Response.json(await room.readRunEvents(who, Number(url.searchParams.get("after") ?? 0)));
    if (url.pathname === "/network-probe") {
      const blocked = await fetch("https://example.invalid/fixture-network-probe");
      return Response.json({ status: blocked.status });
    }
    if (url.pathname === "/retention" && request.method === "POST") {
      await room.openRunJournal(who, source);
      for (let offset = 0; offset < MAX_RUN_ROOM_EVENTS + 1; offset += 32) {
        const through = Math.min(MAX_RUN_ROOM_EVENTS + 1, offset + 32);
        await room.appendRunJournalBatch(who, { ...source, sourceSequence: through, acknowledgedThrough: through,
          events: Array.from({ length: through - offset }, (_, index) => ({ eventId: crypto.randomUUID(), event: { kind: "terminal" as const, stream: "stdout" as const, data: `retention ${offset + index + 1}\n` } })),
        });
      }
      return Response.json({ events: MAX_RUN_ROOM_EVENTS + 1, retained: MAX_RUN_ROOM_EVENTS });
    }
    if (url.pathname !== "/publish" || request.method !== "POST") return new Response("Fixture route not found", { status: 404 });
    const body = await request.json() as { frames: JournalFrame[]; end?: boolean; loseAck?: boolean };
    if (!Array.isArray(body.frames) || body.frames.length > 64) return new Response("Fixture frame bound", { status: 400 });
    const acknowledged = await room.openRunJournal(who, source);
    let lostReplies = 0;
    // Both injected failures occur only after the real SQLite transaction committed.
    const target = { openRunJournal: (...args: Parameters<typeof room.openRunJournal>) => room.openRunJournal(...args), async appendRunJournalBatch(...args: Parameters<typeof room.appendRunJournalBatch>) {
      const ack = await room.appendRunJournalBatch(...args);
      if (body.loseAck && (args[1] as RunJournalBatch).acknowledgedThrough > acknowledged && lostReplies++ < 2) throw new Error("Injected committed acknowledgment loss");
      return ack;
    } };
    const publisherEnv = { ConversationRoom: { getByName: () => target } } as unknown as Env;
    const publisher = await createRunJournalPublisher(publisherEnv, who, source, (text) => text.replaceAll("fixture-secret-value", "[fixture-redacted]"));
    try {
      for (const frame of body.frames) await publisher.accept(frame);
      if (body.end) await publisher.end();
      return Response.json({ acknowledged: publisher.acknowledgedThrough });
    } catch (error) {
      if (body.loseAck && lostReplies === 2) return Response.json({ injected: "committed-acknowledgment-loss" }, { status: 503 });
      throw error;
    }
  },
};
