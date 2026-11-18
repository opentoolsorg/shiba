/**
 * Shared behavioral contract every channel must pass. Test files call
 * runChannelContractSuite once per channel with a fixture; nothing in the
 * Worker bundle imports this module.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../../env.js";
import {
  CHANNEL_CAPABILITIES,
  ChannelUnsupportedError,
  type ChannelAdapter,
  type ChannelDefinition,
  type ChannelMessageRef,
  type InboundAction,
  type InboundMessage,
} from "./index.js";
import { missingChannelSecrets } from "./registry.js";

export interface RecordedRequest {
  url: URL;
  method: string;
}

export interface ChannelContractFixture {
  definition: ChannelDefinition;
  /** Env with every required secret and the outbound token set. */
  env: Env;
  /** The platform authenticates the delivery, not the body bytes. */
  bodyUnsigned?: boolean;
  /** Headers that authenticate `rawBody` for this platform. */
  sign(rawBody: string): Promise<Headers>;
  message: {
    rawBody: string;
    expected: Pick<InboundMessage, "placeId" | "authorId" | "text" | "mentionedUserIds" | "conversationKey" | "deliveryId">;
  };
  action: {
    rawBody: string;
    expected: Pick<InboundAction, "placeId" | "actorId" | "value" | "conversationKey" | "deliveryId">;
  };
  mentions: { text: string; ids: string[] };
  /** Fake platform API; every outbound request goes here. */
  respond(url: URL, init: RequestInit): Response;
  /** Hostnames the adapter may call. */
  hosts: string[];
  ref: ChannelMessageRef;
  thread: { placeId: string; threadId: string };
  file: string;
}

function recordingFetch(fixture: ChannelContractFixture, log: RecordedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    log.push({ url, method: init.method ?? "GET" });
    return fixture.respond(url, init);
  }) as typeof fetch;
}

const CALLS: Record<(typeof CHANNEL_CAPABILITIES)[number], (adapter: ChannelAdapter, fixture: ChannelContractFixture) => Promise<unknown>> = {
  post: (a, f) => a.post({ placeId: f.ref.placeId, text: "hello" }),
  edit: (a, f) => a.edit({ ref: f.ref, text: "edited" }),
  react: (a, f) => a.react(f.ref, "eyes"),
  upload: (a, f) => a.upload({ placeId: f.ref.placeId, filename: "notes.txt", contentType: "text/plain", data: new TextEncoder().encode("hi") }),
  download: (a, f) => a.download(f.file),
  history: (a, f) => a.history(f.thread.placeId, f.thread.threadId, 10),
  recent: (a, f) => a.recent(f.thread.placeId, 10),
  authorName: (a, f) => a.authorName(f.action.expected.actorId, f.ref.placeId),
  placeName: (a, f) => a.placeName(f.ref.placeId),
};

export function runChannelContractSuite(name: string, makeFixture: () => ChannelContractFixture | Promise<ChannelContractFixture>): void {
  describe(`channel contract: ${name}`, () => {
    it("declares required secrets the fixture env satisfies", async () => {
      const f = await makeFixture();
      expect(f.definition.requiredSecrets.length).toBeGreaterThan(0);
      expect(missingChannelSecrets(f.env, f.definition.id)).toEqual([]);
      expect(missingChannelSecrets({} as Env, f.definition.id)).toEqual([...f.definition.requiredSecrets]);
      expect(f.definition.transport.channel).toBe(f.definition.id);
    });

    it("refuses deliveries when unconfigured, unsigned, or tampered", async () => {
      const f = await makeFixture();
      const { transport } = f.definition;
      const body = f.message.rawBody;
      expect(await transport.verify(body, await f.sign(body), f.env)).toEqual({ ok: true });
      expect(await transport.verify(body, await f.sign(body), {} as Env)).toMatchObject({ ok: false, status: 503 });
      expect(await transport.verify(body, new Headers(), f.env)).toMatchObject({ ok: false, status: 401 });
      const tampered = body.replace("hello", "jello");
      expect(tampered).not.toBe(body);
      const verdict = await transport.verify(tampered, await f.sign(body), f.env);
      // Telegram (shared secret) and Teams (JWT bound to serviceUrl) do not sign the body.
      if (f.bodyUnsigned) expect(verdict.ok).toBe(true);
      else expect(verdict).toMatchObject({ ok: false, status: 401 });
    });

    it("parses a message into InboundMessage with its conversation key and mentions", async () => {
      const f = await makeFixture();
      const event = f.definition.transport.parse(f.message.rawBody);
      expect(event).toMatchObject({ kind: "message", channel: f.definition.id, ...f.message.expected });
      expect(f.definition.transport.conversationKey(event!)).toBe(f.message.expected.conversationKey);
    });

    it("parses a button press into InboundAction with its conversation key", async () => {
      const f = await makeFixture();
      const event = f.definition.transport.parse(f.action.rawBody);
      expect(event).toMatchObject({ kind: "action", channel: f.definition.id, ...f.action.expected });
      expect(f.definition.transport.conversationKey(event!)).toBe(f.action.expected.conversationKey);
    });

    it("returns null for payloads that are not messages or actions, never throwing", async () => {
      const f = await makeFixture();
      for (const raw of ["", "not json", "{}", "[]", "null", "payload=%7Bbad"]) {
        expect(f.definition.transport.parse(raw)).toBeNull();
      }
    });

    it("extracts mentioned user ids in order without duplicates", async () => {
      const f = await makeFixture();
      const adapter = f.definition.createAdapter(f.env, { fetch: recordingFetch(f, []) })!;
      expect(adapter.mentions(f.mentions.text)).toEqual(f.mentions.ids);
      expect(adapter.mentions("no mentions here")).toEqual([]);
    });

    it("builds no adapter without its outbound credential", async () => {
      const f = await makeFixture();
      expect(f.definition.createAdapter({} as Env)).toBeNull();
    });

    it("post returns a message ref", async () => {
      const f = await makeFixture();
      const adapter = f.definition.createAdapter(f.env, { fetch: recordingFetch(f, []) })!;
      const ref = await adapter.post({ placeId: f.ref.placeId, text: "hello" });
      expect(ref.placeId).toBe(f.ref.placeId);
      expect(ref.messageId).not.toBe("");
    });

    for (const capability of CHANNEL_CAPABILITIES) {
      it(`${capability}: calls only the platform when supported, else rejects as unsupported`, async () => {
        const f = await makeFixture();
        const log: RecordedRequest[] = [];
        const adapter = f.definition.createAdapter(f.env, { fetch: recordingFetch(f, log) })!;
        expect(adapter.channel).toBe(f.definition.id);
        const call = CALLS[capability](adapter, f);
        if (adapter.capabilities.has(capability)) {
          await call;
          expect(log.length).toBeGreaterThan(0);
          for (const request of log) expect(f.hosts).toContain(request.url.hostname);
        } else {
          await expect(call).rejects.toBeInstanceOf(ChannelUnsupportedError);
          expect(log).toEqual([]);
        }
      });
    }
  });
}
