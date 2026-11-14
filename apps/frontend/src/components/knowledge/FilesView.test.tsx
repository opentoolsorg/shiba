// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilesView } from "./FilesView";

describe("FilesView", () => {
  it("renders files heading and scope selector", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ files: [] }), { status: 200 })));
    render(<FilesView />);
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.getByLabelText(/Scope/i)).toBeTruthy();
  });
});