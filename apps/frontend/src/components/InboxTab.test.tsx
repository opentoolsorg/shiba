// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InboxTab } from "./InboxTab";
import type { InboxDraft, InboxEmail } from "../types";

const json = (value: unknown) => Response.json(value);

const mockEmails: InboxEmail[] = [
  {
    id: "em_1",
    thread_id: "th_1",
    mailbox: "ops@shiba.local",
    direction: "inbound",
    from_addr: "alice@external.test",
    to_addr: "ops@shiba.local",
    subject: "Urgent deployment query",
    body_text: "Please confirm when the next build lands.",
    status: "unread",
    created_at: Date.now() - 60_000,
  },
  {
    id: "em_2",
    thread_id: "th_2",
    mailbox: "ops@shiba.local",
    direction: "outbound",
    from_addr: "ops@shiba.local",
    to_addr: "bob@external.test",
    subject: "Release notes v1.0",
    body_text: "All systems verified.",
    status: "sent",
    created_at: Date.now() - 120_000,
  },
];

const mockDrafts: InboxDraft[] = [
  {
    id: "dr_1",
    mailbox: "ops@shiba.local",
    thread_id: null,
    in_reply_to_email_id: null,
    to_addr: "lead@external.test",
    subject: "Proposed hotfix",
    body_text: "Ready for review before send.",
    status: "draft",
    created_at: Date.now() - 30_000,
    updated_at: Date.now() - 30_000,
  },
  {
    id: "dr_2",
    mailbox: "ops@shiba.local",
    thread_id: null,
    in_reply_to_email_id: null,
    to_addr: "security@external.test",
    subject: "Audit response",
    body_text: "Approval pending.",
    status: "queued",
    created_at: Date.now() - 10_000,
    updated_at: Date.now() - 10_000,
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ mailboxes: [], emails: [], drafts: [] })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InboxTab", () => {
  it("renders breadcrumb row with scope and active folder in header", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/mailboxes") return json({ mailboxes: [] });
      if (path === "/api/approvals") return json({ approvals: [] });
      if (path.startsWith("/api/emails")) return json({ emails: mockEmails });
      if (path.startsWith("/api/drafts")) return json({ drafts: mockDrafts });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<InboxTab scope="personal" activeFolder="inbox" />);

    expect(screen.getByText("Personal")).toBeDefined();
    expect(screen.getByText("Mailbox")).toBeDefined();
    expect(screen.getByText("Inbox")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("Urgent deployment query")).toBeDefined();
    });
  });

  it("filters emails by controlled activeFolder prop", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/mailboxes") return json({ mailboxes: [] });
      if (path === "/api/approvals") return json({ approvals: [] });
      if (path.startsWith("/api/emails")) return json({ emails: mockEmails });
      if (path.startsWith("/api/drafts")) return json({ drafts: mockDrafts });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    const { rerender } = render(<InboxTab scope="workspace" activeFolder="sent" />);

    await waitFor(() => {
      expect(screen.getByText("Release notes v1.0")).toBeDefined();
    });
    expect(screen.queryByText("Urgent deployment query")).toBeNull();

    // Rerender with drafts folder
    rerender(<InboxTab scope="workspace" activeFolder="drafts" />);
    await waitFor(() => {
      expect(screen.getByText("Proposed hotfix")).toBeDefined();
    });
  });

  it("selects thread and opens details reader", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/mailboxes") return json({ mailboxes: [] });
      if (path === "/api/approvals") return json({ approvals: [] });
      if (path.startsWith("/api/emails/em_1")) {
        return json({ mailbox: "ops@shiba.local", email: mockEmails[0], attachments: [] });
      }
      if (path.startsWith("/api/emails")) return json({ emails: mockEmails });
      if (path.startsWith("/api/drafts")) return json({ drafts: mockDrafts });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<InboxTab activeFolder="inbox" />);

    const item = await screen.findByText("Urgent deployment query");
    fireEvent.click(item);

    expect(await screen.findByText("Please confirm when the next build lands.")).toBeDefined();
    expect(screen.getAllByText("alice@external.test").length).toBeGreaterThanOrEqual(1);
  });

  it("handles approval-gated send action for drafts", async () => {
    let sendCalled = false;
    const onOpenApprovals = vi.fn();

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/drafts/dr_1/send" && init?.method === "POST") {
        sendCalled = true;
        return json({ status: "queued", email_id: "em_sent_1" });
      }
      if (path === "/api/mailboxes") return json({ mailboxes: [] });
      if (path === "/api/approvals") return json({ approvals: [] });
      if (path.startsWith("/api/emails")) return json({ emails: [] });
      if (path.startsWith("/api/drafts")) return json({ drafts: mockDrafts });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<InboxTab activeFolder="drafts" onOpenApprovals={onOpenApprovals} />);

    const sendBtn = await screen.findByRole("button", { name: /Send for approval/i });
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(sendCalled).toBe(true);
    });
  });

  it("shows empty state when no items exist in folder", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/mailboxes") return json({ mailboxes: [] });
      if (path === "/api/approvals") return json({ approvals: [] });
      if (path.startsWith("/api/emails")) return json({ emails: [] });
      if (path.startsWith("/api/drafts")) return json({ drafts: [] });
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<InboxTab activeFolder="inbox" />);

    await waitFor(() => {
      expect(screen.getByText(/No mail/i)).toBeDefined();
    });
  });
});
