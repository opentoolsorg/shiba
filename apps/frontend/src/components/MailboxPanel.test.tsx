// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MailboxPanel } from "./MailboxPanel";

const json = (value: unknown) => Response.json(value);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ mailboxes: [], emails: [], drafts: [] })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MailboxPanel", () => {
  it("renders panel header, folder items, and count badges from props", () => {
    const onSelect = vi.fn();
    const onScopeChange = vi.fn();

    render(
      <MailboxPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="inbox"
        onSelect={onSelect}
        counts={{ inbox: 12, unread: 3, sent: 5, drafts: 2, queued: 1 }}
        mailboxes={[{ address: "ops@shiba.local", label: "Operations", agent: "agent-1", created_at: Date.now() }]}
      />,
    );

    expect(screen.getByText("Mailbox")).toBeDefined();
    expect(screen.getByRole("button", { name: /Inbox/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Unread/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Sent/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Drafts/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Queued for approval/i })).toBeDefined();

    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Operations")).toBeDefined();
    expect(screen.getByText("@agent-1")).toBeDefined();
  });

  it("handles folder selection without a duplicate scope switch", () => {
    const onSelect = vi.fn();
    const onScopeChange = vi.fn();

    render(
      <MailboxPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="inbox"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Drafts/i }));
    expect(onSelect).toHaveBeenCalledWith("drafts");

    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("invokes onCompose, onSearch, and onSelectMailbox", () => {
    const onCompose = vi.fn();
    const onSearch = vi.fn();
    const onSelectMailbox = vi.fn();

    render(
      <MailboxPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active="inbox"
        onSelect={vi.fn()}
        onCompose={onCompose}
        onSearch={onSearch}
        onSelectMailbox={onSelectMailbox}
        mailboxes={[{ address: "support@shiba.local", label: "Support", agent: null, created_at: Date.now() }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Compose draft" }));
    expect(onCompose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Search mailbox" }));
    expect(onSearch).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Support/i }));
    expect(onSelectMailbox).toHaveBeenCalledWith("support@shiba.local");
  });

  it("never fetches and shows empty values when data is omitted", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    render(
      <MailboxPanel
        scope="personal"
        onScopeChange={vi.fn()}
        active="inbox"
        onSelect={vi.fn()}
      />,
    );

    expect(fetcher).not.toHaveBeenCalled();
  });
});
