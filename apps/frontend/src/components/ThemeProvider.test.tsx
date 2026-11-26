// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme("light")}>
      {theme}
    </button>
  );
}

const setCookie = (value: string) => {
  // biome-ignore lint/suspicious/noDocumentCookie: simulating the website writing the shared cookie.
  document.cookie = value;
};
const clearCookie = () => setCookie("shiba-theme=; Path=/; Max-Age=0");

beforeEach(() => {
  localStorage.clear();
  clearCookie();
});

afterEach(() => {
  cleanup();
  clearCookie();
});

describe("ThemeProvider shared preference", () => {
  it("starts from the shared cookie instead of the stored or default theme", () => {
    localStorage.setItem("shiba-theme", "dark");
    setCookie("shiba-theme=light; Path=/");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("light");
    expect(localStorage.getItem("shiba-theme")).toBe("light");
  });

  it("defaults to system and publishes it when no preference exists", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("system");
    expect(document.cookie).toContain("shiba-theme=system");
  });

  it("writes dashboard changes back to the shared cookie and follows site changes on focus", () => {
    setCookie("shiba-theme=dark; Path=/");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByRole("button").click());
    expect(document.cookie).toContain("shiba-theme=light");

    setCookie("shiba-theme=dark; Path=/");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("button").textContent).toBe("dark");
  });
});
