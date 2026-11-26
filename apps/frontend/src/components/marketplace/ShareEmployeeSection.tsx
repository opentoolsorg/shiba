import type { JSX } from "react";

/** Static guidance; the export, review and paste-import controls live in AgentTemplatesCatalog. */
export function ShareEmployeeSection(): JSX.Element {
  return <section aria-labelledby="share-employee-heading" className="mt-6 rounded-2xl border border-[var(--border-1)] p-4">
    <h3 id="share-employee-heading" className="text-sm font-semibold">Share an employee</h3>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--muted-foreground-2)]">
      <li>Export: open My templates and choose Export owned bundle on a saved bot. Review the text for private information before sharing it.</li>
      <li>Import: choose Review bundle on a template, or use Paste import below. You review the instructions and skills before anything is created.</li>
      <li>Importing a bundle creates an archived bot with no grants. No accounts are connected, no tool access is given, and no skills are activated. Grant access separately in Tool policy.</li>
      <li>Developer template packs live in the repository&apos;s templates/ directory.</li>
    </ul>
  </section>;
}
