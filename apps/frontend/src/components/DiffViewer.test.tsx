// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffViewer } from "./DiffViewer";

afterEach(cleanup);

describe("DiffViewer binary notice", () => {
  it("explains binary content using the marker git emits", () => {
    render(<DiffViewer diff={"diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n"} />);
    expect(screen.getByRole("status").textContent).toContain("Binary files differ");
  });

  it("stays quiet for an ordinary text diff, even one that mentions binary files in a line", () => {
    render(<DiffViewer diff={"diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+Binary files are ignored by this tool\n"} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
