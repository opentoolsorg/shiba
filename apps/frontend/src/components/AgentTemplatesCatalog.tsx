import { useEffect, useMemo, useState, type JSX } from "react";
import { AGENT_TEMPLATES, validateAgentTemplate, validateEmployeeBundle, type CustomAgentConfig, type EmployeeBundle } from "@shiba/shared";
import { EmployeeBundleExport, EmployeeBundleReview } from "./EmployeeBundleReview";
import { teamWorkspaceHeaders } from "../team-workspaces-client";
import { AgentAvatar } from "./AgentAvatar";
import { Search, ArrowUpRight } from "lucide-react";

function capabilities(template: (typeof AGENT_TEMPLATES)[number]): string[] {
  return [...template.skills, ...template.plugins].map((name) => name.replaceAll("-", " ")).concat(template.chat_lanes.map((lane) => `${lane} threads`), "Approval-gated").slice(0, 3);
}

function pack(template: (typeof AGENT_TEMPLATES)[number]): string {
  return `${JSON.stringify({ template: { ...template, instructions: undefined }, instructions: template.instructions, skills: {} }, null, 2)}\n\n--- INSTRUCTIONS.md ---\n\n# ${template.name}\n\n${template.instructions}\n`;
}

export function AgentTemplatesCatalog({ onUse, workspaceId }: { onUse: (template: (typeof AGENT_TEMPLATES)[number], savedConfig?: CustomAgentConfig) => Promise<void>; workspaceId?: string }): JSX.Element {
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [myTemplates, setMyTemplates] = useState<(typeof AGENT_TEMPLATES)[number][]>([]);
  const [myLoading, setMyLoading] = useState(false);
  const [bundleRecipe, setBundleRecipe] = useState<EmployeeBundle | null>(null);
  const [exportProfile, setExportProfile] = useState<{ employeeId: string; expectedVersion: number } | null>(null);
  const [myProfiles, setMyProfiles] = useState<Record<string, { employeeId: string; expectedVersion: number; codingModel?: string; config: CustomAgentConfig }>>({});
  const categories = ["all", "product", "engineering", "ops", "community", "my"];
  useEffect(() => {
    if (category !== "my") return;
    let current = true;
    setMyTemplates([]); setMyProfiles({});
    setMyLoading(true);
    fetch("/api/custom-agents", { headers: teamWorkspaceHeaders(workspaceId) }).then(async (response) => {
      if (!response.ok) throw new Error("Your saved bots could not be loaded.");
      const body = await response.json() as { agents?: { id?: string; version?: number; slug: string; config: CustomAgentConfig }[] };
      if (!current) return;
      setMyProfiles(Object.fromEntries((body.agents ?? []).filter((agent) => agent.id && agent.version).map((agent) => [agent.slug, { employeeId: agent.id!, expectedVersion: agent.version!, codingModel: agent.config.codingModel, config: agent.config }])));
      setMyTemplates((body.agents ?? []).filter((agent) => agent.config.instructions).map((agent) => ({
        id: agent.slug, name: agent.config.name, description: "Saved bot from your workspace.", categories: ["my"],
        appearance: agent.config.emoji, skills: [], plugins: [], harness: agent.config.harness ?? "opencode", chat_lanes: ["slack"], version: "1.0.0", instructions: agent.config.instructions,
        ...(agent.config.roleTemplateId ? { roleTemplateId: agent.config.roleTemplateId } : {}),
        ...(agent.config.expectedDeliverables ? { expectedDeliverables: [...agent.config.expectedDeliverables] } : {}),
      })));
      setMessage("");
    }).catch((error: unknown) => { if (current) setMessage(error instanceof Error ? error.message : "Your saved bots could not be loaded."); }).finally(() => { if (current) setMyLoading(false); });
    return () => { current = false; };
  }, [category, workspaceId]);
  useEffect(() => { setBundleRecipe(null); setExportProfile(null); setMessage(""); }, [workspaceId]);
  const visible = useMemo(() => (category === "my" ? myTemplates : AGENT_TEMPLATES.filter((item) => category === "all" || item.categories.includes(category))).filter((item) => `${item.name} ${item.description} ${item.categories.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())), [category, myTemplates, query]);
  const featured = category === "all" && !query.trim() ? visible.filter((item) => item.categories.includes("featured")) : [];

  const copy = async (template: (typeof AGENT_TEMPLATES)[number]) => {
    try {
      await navigator.clipboard.writeText(pack(template));
      setMessage(`${template.name} pack copied.`);
    } catch {
      setMessage("Could not copy this pack. Check clipboard access and try again.");
    }
  };
  const clone = async (template: (typeof AGENT_TEMPLATES)[number]) => {
    setBusy(true);
    try {
      if (category === "my") await onUse(template, myProfiles[template.id]?.config);
      else await onUse(template);
      setMessage(`${template.name} added to your bots. Review its instructions before starting a task.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create bot from template."); }
    finally { setBusy(false); }
  };
  const reviewTemplate = (template: (typeof AGENT_TEMPLATES)[number]) => {
    setExportProfile(null);
    const savedProfile = category === "my" ? myProfiles[template.id] : undefined;
    setBundleRecipe(validateEmployeeBundle({
      format: "shiba.employee-bundle.v1", audience: "personal",
      profile: { name: template.name, instructions: template.instructions, harness: template.harness ?? "opencode",
        ...(savedProfile?.codingModel ? { codingModel: savedProfile.codingModel } : {}),
        ...(savedProfile?.config.mascotPreset ? { mascotPreset: savedProfile.config.mascotPreset } : {}),
        ...(template.appearance ? { emoji: template.appearance } : {}),
        ...(template.roleTemplateId ? { roleTemplateId: template.roleTemplateId } : {}),
        expectedDeliverables: template.expectedDeliverables ?? [],
        provenance: savedProfile ? { kind: "employee", id: savedProfile.employeeId, revision: String(savedProfile.expectedVersion) }
          : { kind: "catalog", id: template.id, revision: template.version } },
      skills: [], routines: [],
      requirements: [
        ...template.skills.map((name) => ({ kind: "skill", name, description: "Template recommendation; no managed skill body is included.", configurationRequired: ["Find and review a managed skill", "Activate an exact version before selecting it"] })),
        ...template.plugins.map((name) => ({ kind: "app", name, description: "Template recommendation; connection availability must be checked.", configurationRequired: ["Connect your own account if supported", "Review exact tool and resource permissions"] })),
      ],
    }));
  };
  const importPack = async () => {
    try {
      const [jsonBlock, markdown] = importText.split("\n\n--- INSTRUCTIONS.md ---\n", 2);
      const parsed = JSON.parse(jsonBlock ?? "") as { template?: unknown; instructions?: unknown };
      if ("format" in parsed) {
        setExportProfile(null);
        setBundleRecipe(validateEmployeeBundle(parsed));
        setMessage("Review the bundle before importing. Nothing has been created yet.");
        return;
      }
      const instructions = markdown?.trim().replace(/^# [^\n]+\n\n/, "") ?? parsed.instructions;
      const metadata = validateAgentTemplate({ ...(parsed.template as object), instructions });
      setBusy(true);
      const slug = metadata.id.slice(0, 48);
      const response = await fetch("/api/custom-agents", { method: "POST", headers: { "Content-Type": "application/json", ...teamWorkspaceHeaders(workspaceId) }, body: JSON.stringify({ slug, config: { name: metadata.name, instructions: metadata.instructions, harness: metadata.harness ?? "opencode", ...(metadata.roleTemplateId ? { roleTemplateId: metadata.roleTemplateId } : {}), ...(metadata.expectedDeliverables ? { expectedDeliverables: metadata.expectedDeliverables } : {}), ...(metadata.appearance ? { emoji: metadata.appearance } : {}) } }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Import failed (${response.status}).`);
      setMessage(`${metadata.name} imported as a bot.`);
      setImportText("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Paste a valid Shiba template pack."); }
    finally { setBusy(false); }
  };

  const chip = "min-h-11 rounded-full border px-3.5 text-xs font-medium capitalize transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] sm:min-h-9";
  const primaryBtn = "inline-flex min-h-11 flex-1 items-center justify-center gap-1 rounded-lg border border-[var(--primary)] bg-[var(--primary)] px-3 text-xs font-semibold text-[var(--primary-text)] transition-transform hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-50";
  const secondaryBtn = "inline-flex min-h-11 items-center justify-center rounded-lg border border-[var(--border-1)] px-3 text-xs font-medium hover:bg-[var(--bg-2,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]";
  const quietBtn = "min-h-11 px-1 text-xs text-[var(--muted-foreground-2)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";

  return <section id="agent-catalog" aria-label="Agent template marketplace" className="agent-catalog">
    <header className="agent-catalog-hero flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="agent-eyebrow">A little team. A lot of possibility.</p><h2>Your next great teammate.</h2><p>Give the work a home. Hire a specialist, start a thread, and build on what you learn together.</p><div className="agent-provider-row" role="group" aria-label="Provider options">{["Codex", "Claude Code", "Gemini", "Grok", "OpenCode", "Cursor"].map((provider) => <span key={provider}>{provider}</span>)}</div><p className="agent-provider-note">Change the provider, keep the agent. Connections are configured separately.</p></div><div className="agent-hero-cast flex -space-x-3" aria-hidden="true">{["coding-coworker", "product-spec-writer", "support-triage"].map((id) => <AgentAvatar key={id} id={id} name="" size={80} decorative className="rounded-full border-2 border-[var(--bg)]" />)}</div></header>
    <div className="agent-catalog-tools mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h3>Template catalog</h3><p>{AGENT_TEMPLATES.length} thoughtful starting points. Always yours to customize.</p></div><label className="agent-search flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--border-1)] px-3 focus-within:border-[var(--primary)] sm:w-72"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search templates" placeholder="Find your teammate…" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full bg-transparent text-sm outline-none" /></label></div>
    <div className="agent-filter-row -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Template filters">{categories.map((item) => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)} className={`${chip} shrink-0 ${category === item ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-text)]" : "border-[var(--border-1)]"}`}>{item === "all" ? "All teammates" : item === "my" ? "My templates" : item}</button>)}<select aria-label="Template category" value={category} onChange={(event) => setCategory(event.target.value)} className="sr-only">{categories.map((item) => <option key={item} value={item}>{item === "all" ? "All templates" : item}</option>)}</select></div>
    {featured.length ? <section aria-label="Featured teammates" className="agent-featured mt-5"><p className="agent-eyebrow">Featured · Start something good</p><div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{featured.map((template) => <button type="button" key={template.id} disabled={busy} onClick={() => void clone(template)} className="group flex items-center gap-3 rounded-xl border border-[var(--border-1)] p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"><AgentAvatar id={template.id} name={template.name} size={64} decorative /><span className="min-w-0"><strong className="block text-sm">{template.name}</strong><small className="line-clamp-2 text-xs text-[var(--muted-foreground-2)]">{template.description}</small><span className="agent-featured-cta mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[var(--primary)]">Hire teammate <ArrowUpRight size={14} aria-hidden="true" /></span></span></button>)}</div></section> : null}
    {message ? <p role="status" className="mt-3 text-xs text-[var(--muted-foreground-2)]">{message}</p> : null}
    {myLoading ? <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">Loading your saved bots…</p> : null}
    {category === "my" && !myLoading && visible.length === 0 ? <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">No saved bots yet. Use an official template or create a bot to see it here.</p> : null}
    {!visible.length && !myLoading && category !== "my" ? <p className="py-8 text-sm text-[var(--muted-foreground-2)]">No teammates match your search. Try another name or category.</p> : null}
    <div className="agent-template-grid mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{visible.map((template) => <article key={template.id} className="agent-template-card group flex flex-col rounded-2xl border border-[var(--border-1)] p-4 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <div className="agent-card-top flex items-start justify-between gap-2"><AgentAvatar id={template.id} name={template.name} mascotPreset={category === "my" ? myProfiles[template.id]?.config.mascotPreset : undefined} size={80} decorative className="agent-card-mascot transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100" /><span className="agent-category rounded-full border border-[var(--border-1)] px-2.5 py-0.5 text-[11px] capitalize text-[var(--muted-foreground-2)]">{template.categories.find((tag) => tag !== "featured")}</span></div>
      <h3 className="mt-3 text-base font-semibold">{template.name}</h3><p className="agent-value-prop mt-1 text-sm text-[var(--muted-foreground-2)]">{template.description}</p><div className="agent-capabilities mt-3 flex flex-wrap gap-1.5">{capabilities(template).map((tag) => <span key={tag} className="rounded-md bg-[var(--bg-2,rgba(127,127,127,.12))] px-2 py-0.5 text-[11px] capitalize">{tag}</span>)}</div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4"><button type="button" disabled={busy} onClick={() => void clone(template)} className={primaryBtn}>Hire <ArrowUpRight size={14} aria-hidden="true" /></button><button type="button" onClick={() => void copy(template)} className={secondaryBtn}>Copy pack</button>{category !== "my" ? <button type="button" className={quietBtn} onClick={() => reviewTemplate(template)}>Review bundle</button> : null}{myProfiles[template.id] ? <button type="button" className={quietBtn} onClick={() => { setBundleRecipe(null); setExportProfile(myProfiles[template.id]!); }}>Export owned bundle</button> : null}{category === "my" ? <button type="button" className={quietBtn} onClick={() => reviewTemplate(template)}>Save as new archived bot</button> : null}</div>
    </article>)}</div>
    {bundleRecipe ? <EmployeeBundleReview key={`${workspaceId ?? "personal"}:${JSON.stringify(bundleRecipe)}`} workspaceId={workspaceId} recipe={bundleRecipe} onClose={() => setBundleRecipe(null)} onImported={(result) => { setMessage(`${bundleRecipe.profile.name} imported as an archived bot with ${result.skillIds.length} draft skills. Review and restore it in your bots; configure recommendations separately.`); setBundleRecipe(null); setImportText(""); }}/> : null}
    {exportProfile ? <EmployeeBundleExport key={`${workspaceId ?? "personal"}:${exportProfile.employeeId}`} workspaceId={workspaceId} {...exportProfile} onClose={() => setExportProfile(null)}/> : null}
    <details className="mt-4 border-t border-[var(--border-1)] pt-3"><summary className="cursor-pointer text-xs font-semibold">Paste import</summary><p className="my-2 text-xs text-[var(--muted-foreground-2)]">Paste a Shiba template pack or complete employee bundle. Complete bundles require an instruction and skill review before creating an archived bot. Legacy packs create bot configuration only; their skill and plugin names are recommendations.</p><textarea aria-label="Template pack JSON" value={importText} onChange={(event) => setImportText(event.target.value)} rows={5} className="w-full border border-[var(--border-1)] bg-[var(--bg)] p-2 font-mono text-xs" placeholder="Paste template pack or employee bundle JSON"/><button type="button" disabled={busy || !importText.trim()} onClick={() => void importPack()} className="mt-2 min-h-11 border border-[var(--primary)] px-3 py-1.5 text-xs disabled:opacity-50">{busy ? "Importing…" : "Create bot from pack"}</button></details>
  </section>;
}
