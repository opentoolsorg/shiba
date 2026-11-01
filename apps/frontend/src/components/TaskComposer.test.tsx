// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskComposer, type TaskComposerProps } from "./TaskComposer";

afterEach(() => cleanup());

const routing = {
  codingModel: "",
  connectionId: "",
  reasoningEffort: "" as const,
  onCodingModelChange: vi.fn(),
  onConnectionChange: vi.fn(),
  onReasoningEffortChange: vi.fn(),
};

function renderComposer(variant: "hero" | "docked", overrides: Partial<TaskComposerProps> = {}) {
  render(
    <TaskComposer
      repoUrl={overrides.repoUrl ?? ""}
      task={overrides.task ?? ""}
      baseBranch="main"
      publishPullRequest={false}
      harness="opencode"
      routing={routing}
      busy={false}
      isSubmitting={false}
      clearing={false}
      onRepoUrlChange={vi.fn()}
      onTaskChange={vi.fn()}
      onBaseBranchChange={vi.fn()}
      onPublishPullRequestChange={vi.fn()}
      onHarnessChange={vi.fn()}
      onSubmit={vi.fn()}
      onClear={vi.fn()}
      variant={variant}
      {...overrides}
    />,
  );
}

describe("TaskComposer", () => {
  it("places repository and execution target below the prompt and send controls", () => {
    const onSubmit = vi.fn();
    renderComposer("hero", { task: "Write a market report", onRunTargetChange: vi.fn(), onSubmit });
    const prompt = screen.getByRole("textbox", { name: "Task description" });
    const send = screen.getByRole("button", { name: "Send task" });
    const repo = screen.getByRole("button", { name: "Project: Select repository" });
    const target = screen.getByRole("button", { name: "Run on: Cloud" });
    expect(prompt.compareDocumentPosition(repo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(send.compareDocumentPosition(repo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prompt.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(repo.textContent).toContain("Connect repository");
    expect(screen.getByText(/required for execution, including reports and research/)).toBeTruthy();
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Task composer" }));
    fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the work target available and explains a blocked submission", () => {
    const onSubmit = vi.fn();
    const onAppToolsWorkChange = vi.fn();
    const onExecutionTargetKindChange = vi.fn();
    renderComposer("docked", { repoUrl: "https://github.com/example/work", task: "Prepare a brief",
      blockedReason: "Review the saved first task before sending.", onSubmit,
      onAppToolsWorkChange, onExecutionTargetKindChange });
    expect(screen.getByRole("status").textContent).toBe("Review the saved first task before sending.");
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Task composer" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Work target" }), { target: { value: "artifact-workspace" } });
    expect(onAppToolsWorkChange).toHaveBeenCalledWith(false);
    expect(onExecutionTargetKindChange).toHaveBeenCalledWith("artifact-workspace");
  });

  it("preserves the selected employee in configuration without a bot identity line in the prompt", () => {
    const onCustomAgentChange = vi.fn();
    const onSubmit = vi.fn();
    renderComposer("docked", { repoUrl: "https://github.com/example/work", task: "Prepare a launch brief",
      customAgentId: "marketing", customAgents: [{ id: "marketing", name: "Marketing bot", slug: "marketing" }],
      onCustomAgentChange, onSubmit });
    expect(screen.queryByText(/Bot:/)).toBeNull();
    expect(screen.queryByText("Marketing bot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thread configuration" }));
    expect(screen.getByRole("menuitemradio", { name: /Marketing bot/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Thread configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    expect(onCustomAgentChange).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("offers balanced general examples as editable drafts, never automatic submissions", () => {
    const onTaskChange = vi.fn();
    const onSubmit = vi.fn();
    renderComposer("hero", { onTaskChange, onSubmit });
    const prompts = [
      "Draft a marketing campaign brief from the product notes",
      "Prepare a sales account brief from my supplied notes",
      "Research a market question and write a report with sources",
      "Turn customer feedback into a product and design brief",
      "Fix a small bug and add a regression test",
    ];
    for (const prompt of prompts) expect(screen.getByRole("button", { name: prompt })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: prompts[0] }));
    expect(onTaskChange).toHaveBeenCalledWith(prompts[0]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Task description" }));
  });

  it.each(["hero", "docked"] as const)("keeps the named %s composer outside scroll-clipping ancestors", (variant) => {
    renderComposer(variant, { agentName: "Shiba" });
    const composer = screen.getByRole("form", { name: "Task composer" });
    let ancestor = composer.parentElement;
    while (ancestor) {
      expect(ancestor.className).not.toMatch(/(?:^|\s)overflow(?:-[xy])?-(?:auto|scroll|hidden)(?:\s|$)/);
      ancestor = ancestor.parentElement;
    }
    if (variant === "hero") {
      const emptyStateScroller = screen.getByRole("heading", { name: "Shiba" }).closest(".overflow-y-auto");
      expect(emptyStateScroller).toBeTruthy();
      expect(emptyStateScroller?.contains(composer)).toBe(false);
    }
  });

  it("returns environment editor focus to its menu or chip opener on Escape", () => {
    renderComposer("docked", { envVars: [{ name: "REPORT_TOPIC", value: "Launch" }], onEnvVarsChange: vi.fn() });
    const add = screen.getByRole("button", { name: "Add to message" });
    const chip = screen.getByRole("button", { name: "1 environment variable attached" });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("menuitem", { name: /Environment variables/ }));
    let editor = screen.getByRole("menu", { name: "Environment variables" });
    expect(document.activeElement).toBe(editor.querySelector("input"));
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(add);
    fireEvent.click(chip);
    editor = screen.getByRole("menu", { name: "Environment variables" });
    expect(document.activeElement).toBe(editor.querySelector("input"));
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("focuses the repository picker and restores its trigger on Escape", () => {
    renderComposer("docked");
    const trigger = screen.getByRole("button", { name: "Project: Select repository" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search repositories" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search repositories" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("uses the selected profile slug rather than a custom name for the empty-state role", () => {
    renderComposer("hero", { agentName: "Evidence partner", customAgentId: "research-1", customAgents: [{ id: "research-1", name: "Evidence partner", slug: "research-bot" }] });
    expect(screen.getByRole("heading", { name: "Evidence partner" })).toBeTruthy();
    expect(document.querySelector('[data-employee-role="research"]')).toBeTruthy();
    expect(document.querySelector('[data-employee-role="custom"]')).toBeNull();
  });

  it("shows the agent empty state and bottom composer with prefill-only role examples", () => {
    const onTaskChange = vi.fn();
    const onSubmit = vi.fn();
    const prompt = "Research my top three competitors and write a one-page brief";
    renderComposer("hero", { agentName: "Research bot", examplePrompts: [prompt], onTaskChange, onSubmit });
    expect(screen.getByRole("heading", { name: "Research bot" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Task description" }).getAttribute("placeholder")).toBe("What do you want to get done? Share the goal, context, and output you need.");
    expect(screen.getByText("Shiba can make mistakes. Check important info.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to message" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    expect(onTaskChange).toHaveBeenCalledWith(prompt);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Task description" }));
  });

  it("disables example prefill and preserves a typed draft", () => {
    const onTaskChange = vi.fn();
    const prompt = "Research competitors";
    renderComposer("hero", { agentName: "Research bot", examplePrompts: [prompt], task: "My unfinished task", onTaskChange });
    const example = screen.getByRole("button", { name: prompt }) as HTMLButtonElement;
    expect(example.disabled).toBe(true);
    expect(example.title).toBe("Clear your draft to use an example");
    fireEvent.click(example);
    expect(onTaskChange).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Task description" }) as HTMLTextAreaElement).value).toBe("My unfinished task");
  });

  it("states the empty-thread prompt and keeps send disabled until there is a task", () => {
    renderComposer("hero");
    expect(screen.getByRole("heading", { name: "What would you like to get done?" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Task description" }).getAttribute("placeholder")).toBe(
      "What do you want to get done? Share the goal, context, and output you need.",
    );
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  });


  it("lets a user select project context and explicitly apply its employee defaults", () => {
    const onProjectContextChange = vi.fn();
    const onApplyProjectDefaults = vi.fn();
    renderComposer("docked", {
      task: "Fix launch issue",
      repoUrl: "https://github.com/example/project",
      projectContextId: "memproj_aaaaaaaaaaaaaaaaaaaaaaaa",
      projects: [{ id: "memproj_aaaaaaaaaaaaaaaaaaaaaaaa", name: "Launch", purpose: "Release project", defaultCustomAgentId: "employee-1", defaultHarness: "opencode" }],
      onProjectContextChange,
      onApplyProjectDefaults,
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Project context" }), { target: { value: "memproj_aaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(onProjectContextChange).toHaveBeenCalledWith("memproj_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(onApplyProjectDefaults).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply project defaults" }));
    expect(onApplyProjectDefaults).toHaveBeenCalledWith({ defaultCustomAgentId: "employee-1", defaultHarness: "opencode" });
  });

  it("allows an artifact-workspace draft without a GitHub repository and keeps connected-app unavailable", () => {
    renderComposer("docked", {
      executionTargetKind: "artifact-workspace",
      onExecutionTargetKindChange: vi.fn(),
      artifactWorkspaceName: "Quarterly planning",
      artifactDeliverables: "deliverables/brief.md",
      task: "Draft a grounded product brief",
      repoUrl: "",
    });
    expect(screen.getByRole("button", { name: "Work in: Artifact workspace" })).toBeTruthy();
    expect(screen.getByText("Outputs are saved in an artifact workspace. No repository required.")).toBeTruthy();
    expect(screen.queryByText(/Connect a repository — required for execution/)).toBeNull();
    expect((screen.getByLabelText("Artifact workspace name") as HTMLInputElement).value).toBe("Quarterly planning");
    expect((screen.getByLabelText("Artifact deliverables") as HTMLTextAreaElement).value).toBe("deliverables/brief.md");
    expect((screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Work in: Artifact workspace" }));
    expect(screen.getByText("Unavailable — no permissioned write adapter")).toBeTruthy();
  });

  it("blocks unsafe artifact output paths before a task can be sent", () => {
    renderComposer("docked", {
      executionTargetKind: "artifact-workspace",
      artifactDeliverables: "../secrets.md",
      task: "Draft a brief",
      repoUrl: "",
    });
    expect((screen.getByRole("button", { name: "Send task" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["", " \n\t"])("blocks sending an artifact task with an empty output list (%j)", (artifactDeliverables) => {
    const onSubmit = vi.fn();
    renderComposer("docked", { executionTargetKind: "artifact-workspace", artifactDeliverables, task: "Draft a brief", repoUrl: "", onSubmit });
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task description" }), { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits valid artifact input with Ctrl+Enter without requiring a repository", () => {
    const onSubmit = vi.fn();
    renderComposer("docked", { executionTargetKind: "artifact-workspace", artifactDeliverables: "reports/brief.md", task: "Draft a brief", repoUrl: "", onSubmit });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task description" }), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("explains the approval gate and labels the deployment default truthfully", () => {
    renderComposer("hero");
    expect(screen.getByText("Plan a campaign, prepare sales materials, research a question, or build something. Connect a repository for execution. Planning can start before approval; standard sandbox execution requires approval.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Model: Auto" }).textContent).toContain("Auto");
    expect(screen.getByRole("button", { name: "Send task" }).className).toContain("size-11");

  });

  it("docks without the empty-thread heading once a run is going", () => {
    renderComposer("docked");
    expect(screen.queryByRole("heading", { name: "What would you like to get done?" })).toBeNull();
  });

  it("renders the effort chip for claude-code and lists options on open", () => {
    renderComposer("docked", { harness: "claude-code" });
    const chip = screen.getByRole("button", { name: "Reasoning effort: default" });
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("Effort");
    fireEvent.click(chip);
    for (const label of ["Default", "Low", "Medium", "High", "Xhigh", "Max"]) {
      expect(screen.getByRole("menuitemradio", { name: label })).toBeTruthy();
    }
  });

  it("does not render the effort chip for an unsupported harness like devin", () => {
    renderComposer("docked", { harness: "devin" });
    expect(screen.queryByRole("button", { name: /reasoning effort/i })).toBeNull();
  });

  it("calls onReasoningEffortChange with high when High is clicked", () => {
    const onReasoningEffortChange = vi.fn();
    renderComposer("docked", {
      harness: "claude-code",
      routing: {
        ...routing,
        onReasoningEffortChange,
      },
    });
    const chip = screen.getByRole("button", { name: "Reasoning effort: default" });
    fireEvent.click(chip);
    const highOption = screen.getByRole("menuitemradio", { name: "High" });
    fireEvent.click(highOption);
    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });

  it("opens Environment variables from the + menu and handles adding a variable", () => {
    const onEnvVarsChange = vi.fn();
    renderComposer("docked", { onEnvVarsChange });
    const addBtn = screen.getByRole("button", { name: "Add to message" });
    fireEvent.click(addBtn);
    const envMenuItem = screen.getByRole("menuitem", { name: "Environment variables" });
    fireEvent.click(envMenuItem);

    const nameInput = screen.getByPlaceholderText("NAME");
    const valInput = screen.getByPlaceholderText("value");
    expect(valInput.getAttribute("type")).toBe("password");
    expect(valInput.getAttribute("autocomplete")).toBe("off");

    fireEvent.change(nameInput, { target: { value: "API_KEY" } });
    fireEvent.change(valInput, { target: { value: "secret123" } });

    const addVarBtn = screen.getByRole("button", { name: "Add variable" });
    fireEvent.click(addVarBtn);

    expect(onEnvVarsChange).toHaveBeenCalledWith([{ name: "API_KEY", value: "secret123" }]);
  });

  it("shows count chip when named env vars exist and clicking it opens the editor", () => {
    const onEnvVarsChange = vi.fn();
    renderComposer("docked", {
      envVars: [{ name: "DATABASE_URL", value: "secret" }],
      onEnvVarsChange,
    });
    const chip = screen.getByRole("button", { name: "1 environment variable attached" });
    expect(chip.textContent).toContain("ENV ×1");
    fireEvent.click(chip);

    const removeBtn = screen.getByRole("button", { name: "Remove DATABASE_URL" });
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn);
    expect(onEnvVarsChange).toHaveBeenCalledWith([]);
  });

  it("opening Thread configuration shows the Run repo setup checkbox, and toggling it calls onRunSetupChange(true)", () => {
    const onRunSetupChange = vi.fn();
    renderComposer("docked", { onRunSetupChange });
    const configBtn = screen.getByRole("button", { name: "Thread configuration" });
    fireEvent.click(configBtn);

    const setupCheckbox = screen.getByRole("menuitemcheckbox", { name: "Run repo setup" });
    expect(setupCheckbox).toBeTruthy();
    expect(setupCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Runs .shiba/setup.json initialize before the agent")).toBeTruthy();

    fireEvent.click(setupCheckbox);
    expect(onRunSetupChange).toHaveBeenCalledWith(true);
  });

  describe("voice dictation", () => {
    it("renders no button when unsupported", () => {
      renderComposer("docked");
      expect(screen.queryByRole("button", { name: /voice input/i })).toBeNull();
    });

    it("with a fake SpeechRecognition class on window, clicking starts it and flips aria-pressed", () => {
      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult = null;
        onerror = null;
        onend = null;
        start = vi.fn();
        stop = vi.fn();
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
      try {
        renderComposer("docked");
        const btn = screen.getByRole("button", { name: "Voice input" });
        expect(btn.getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(btn);
        expect(btn.getAttribute("aria-pressed")).toBe("true");
        expect(btn.getAttribute("aria-label")).toBe("Stop voice input");
      } finally {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      }
    });

    it("a fired result event calls onTaskChange with the appended text", () => {
      interface SpeechResultItem {
        transcript: string;
      }
      interface SpeechResult {
        isFinal?: boolean;
        length: number;
        0: SpeechResultItem;
      }
      interface SpeechEvent {
        resultIndex: number;
        results: SpeechResult[];
      }
      let instance: {
        onresult: ((event: SpeechEvent) => void) | null;
        start: () => void;
        stop: () => void;
      } | null = null;

      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult: ((event: SpeechEvent) => void) | null = null;
        onerror = null;
        onend = null;
        start = vi.fn();
        stop = vi.fn();
        constructor() {
          instance = this;
        }
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
      const onTaskChange = vi.fn();
      try {
        renderComposer("docked", { task: "initial task", onTaskChange });
        const btn = screen.getByRole("button", { name: "Voice input" });
        fireEvent.click(btn);
        expect(instance).toBeTruthy();
        if (instance) {
          (instance as { onresult: ((event: SpeechEvent) => void) | null }).onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, length: 1, 0: { transcript: "additional text" } }],
          });
        }
        expect(onTaskChange).toHaveBeenCalledWith("initial task additional text");
      } finally {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      }
    });

    it("clicking again stops it", () => {
      let instance: {
        stop: () => void;
        onend: (() => void) | null;
      } | null = null;

      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult = null;
        onerror = null;
        onend: (() => void) | null = null;
        start = vi.fn();
        stop = vi.fn(() => {
          this.onend?.();
        });
        constructor() {
          instance = this;
        }
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
      try {
        renderComposer("docked");
        const btn = screen.getByRole("button", { name: "Voice input" });
        fireEvent.click(btn);
        expect(btn.getAttribute("aria-pressed")).toBe("true");

        fireEvent.click(btn);
        expect(instance).toBeTruthy();
        if (instance) {
          expect((instance as { stop: () => void }).stop).toHaveBeenCalled();
        }
        expect(btn.getAttribute("aria-pressed")).toBe("false");
        expect(btn.getAttribute("aria-label")).toBe("Voice input");
      } finally {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      }
    });
  });

  it("shows an unavailable saved bot and prevents a silent fallback to the standard agent", () => {
    renderComposer("docked", { customAgentId: "deleted-bot", repoUrl: "https://github.com/example/a", task: "Fix login" });
    expect(screen.getByRole("status").textContent).toContain("Bot unavailable");
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  });

  it("distinguishes a loading bot from a deleted bot", () => {
    renderComposer("docked", { customAgentId: "pending-bot", customAgentsLoading: true });
    expect(screen.getByRole("status").textContent).toContain("Loading bot");
    expect(screen.queryByText(/Bot unavailable/)).toBeNull();
  });
});
