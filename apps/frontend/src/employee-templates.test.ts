import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_ROLE_TEMPLATE_IDS, expectedDeliverablesSchema } from "@shiba/shared";
import { EMPLOYEE_TEMPLATES, employeeRole, recommendEmployeeTemplate } from "./employee-templates";

describe("employee role templates", () => {
  it("preserves existing roles and offers GTM, HR and finance as optional editable identities", () => {
    expect(EMPLOYEE_TEMPLATES.map((template) => template.label)).toEqual(["Engineering", "Marketing", "Sales", "Product", "Design", "Research", "Operations", "GTM", "HR", "Finance"]);
    expect(EMPLOYEE_TEMPLATES.map((template) => template.id)).toEqual(CUSTOM_AGENT_ROLE_TEMPLATE_IDS);
    expect(new Set(EMPLOYEE_TEMPLATES.map((template) => template.slug)).size).toBe(EMPLOYEE_TEMPLATES.length);
    for (const template of EMPLOYEE_TEMPLATES) {
      expect(template.slug).toMatch(/^[a-z0-9-]{1,48}$/);
      expect(template.config.name).toBe(`${template.label} bot`);
      expect(template.config.emoji).toBeTruthy();
      expect(template.config.roleTemplateId).toBe(template.id);
      expect(template.config.instructions).toContain("approved repository");
      expect(template.config.instructions).toContain("editable draft");
      expect(template.config.instructions).toContain("separate approval for the exact action");
      expect(template.config.instructions).toContain("Never invent research, citations, customer quotes, metrics");
      expect(template.config.instructions).toContain("precise blocker");
      expect(template.config.instructions).toContain("Choosing a role does not connect apps, install MCP servers or skills");
      expect(template.config.instructions).toContain("artifact workspace");
      expect(Object.keys(template.config).sort()).toEqual(["emoji", "expectedDeliverables", "instructions", "name", "roleTemplateId"]);
    }
  });

  it("names concrete required workspace files that its instructions actually request", () => {
    expect(EMPLOYEE_TEMPLATES.map((template) => template.config.expectedDeliverables)).toEqual([
      [],
      ["marketing/brief.md", "marketing/campaign.md"],
      ["sales/account-brief.md", "sales/outreach.md"],
      ["product/brief.md"],
      ["design/spec.md"],
      ["research/report.md", "research/sources.json"],
      ["operations/runbook.md"],
      ["gtm/strategy.md", "gtm/launch-plan.md"],
      ["hr/brief.md", "hr/workflow.md"],
      ["finance/analysis.md", "finance/assumptions.json"],
    ]);
    for (const template of EMPLOYEE_TEMPLATES) {
      expect(expectedDeliverablesSchema.safeParse(template.config.expectedDeliverables).success).toBe(true);
      for (const file of template.config.expectedDeliverables ?? []) {
        expect(file).toMatch(/^[a-z]+\/[a-z-]+\.(md|json)$/);
        expect(template.config.instructions).toContain(file);
      }
    }
  });

  it("keeps role provenance through a rename and supports legacy exact slugs", () => {
    expect(employeeRole("my-people-helper", "hr")).toBe("hr");
    expect(employeeRole("sales-bot", "finance")).toBe("finance");
    expect(employeeRole("finance-bot")).toBe("finance");
    expect(employeeRole("my-finance-bot")).toBe("custom");
  });

  it("keeps sensitive role outcomes as evidence-based drafts under human control", () => {
    const instructions = (id: string) => EMPLOYEE_TEMPLATES.find((template) => template.id === id)!.config.instructions;
    expect(instructions("gtm")).toContain("Mark unapproved budgets, dates, and owners as proposals");
    expect(instructions("hr")).toContain("Use personal information only when explicitly supplied or shared for this approved task");
    expect(instructions("hr")).toContain("Do not rank candidates, make hiring or employment decisions");
    expect(instructions("finance")).toContain("reproduce material arithmetic");
    expect(instructions("finance")).toContain("Do not move money, purchase, trade");
  });

  it.each([
    [{ role: "Engineering manager", goal: "", help: "" }, "engineering"],
    [{ role: "Product", goal: "", help: "" }, "product"],
    [{ role: "GTM", goal: "", help: "" }, "gtm"],
    [{ role: "HR partner", goal: "", help: "" }, "hr"],
    [{ role: "Founder", goal: "Prepare a cash flow forecast", help: "" }, "finance"],
    [{ role: "", goal: "Create a go-to-market plan", help: "" }, "gtm"],
    [{ role: "", goal: "Review accessibility", help: "" }, "design"],
    [{ role: "", goal: "", help: "" }, undefined],
    [{ role: "Founder", goal: "Help my team", help: "" }, undefined],
    [{ role: "Sales and marketing", goal: "Draft a campaign", help: "" }, undefined],
    [{ role: "", goal: "Research and design", help: "" }, undefined],
    [{ role: "DevOps", goal: "", help: "" }, undefined],
  ] as const)("suggests a role only for unambiguous input %j", (input, role) => {
    expect(recommendEmployeeTemplate(input)?.id).toBe(role);
  });

  it("gives research and operations an evidence standard instead of fabricated outcomes", () => {
    const research = EMPLOYEE_TEMPLATES.find((template) => template.id === "research");
    const operations = EMPLOYEE_TEMPLATES.find((template) => template.id === "operations");
    expect(research?.config.instructions).toContain("Separate verified facts from inferences and hypotheses");
    expect(research?.config.instructions).toContain("Validate the JSON");
    expect(research?.config.instructions).toContain("Never invent citations");
    expect(operations?.config.instructions).toContain("rollback or recovery steps");
    expect(operations?.config.instructions).toContain("Do not claim a schedule, notification, backup, or deployment exists");
  });
});
