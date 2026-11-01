import { describe, expect, it } from "vitest";
import { EMPLOYEE_TEMPLATES } from "./employee-templates";

describe("employee role templates", () => {
  it("offers seven distinct editable bot identities without claiming an external integration", () => {
    expect(EMPLOYEE_TEMPLATES.map((template) => template.label)).toEqual(["Engineering", "Marketing", "Sales", "Product", "Design", "Research", "Operations"]);
    expect(new Set(EMPLOYEE_TEMPLATES.map((template) => template.slug)).size).toBe(7);
    for (const template of EMPLOYEE_TEMPLATES) {
      expect(template.slug).toMatch(/^[a-z0-9-]{1,48}$/);
      expect(template.config.name).toBe(`${template.label} bot`);
      expect(template.config.emoji).toBeTruthy();
      expect(template.config.instructions).toContain("approved repository");
      expect(template.config.instructions).toContain("editable draft");
      expect(template.config.instructions).toContain("separate approval for the exact action");
      expect(template.config.instructions).toContain("Never invent research, citations, customer quotes, metrics");
      expect(template.config.instructions).toContain("precise blocker");
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
    ]);
    for (const template of EMPLOYEE_TEMPLATES) {
      for (const file of template.config.expectedDeliverables ?? []) {
        expect(file).toMatch(/^[a-z]+\/[a-z-]+\.(md|json)$/);
        expect(template.config.instructions).toContain(file);
      }
    }
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
