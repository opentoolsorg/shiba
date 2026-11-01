import { useEffect, useMemo, useState, type JSX } from "react";
import { AGENT_TEMPLATES, validateAgentTemplate } from "@shiba/shared";

function pack(template: (typeof AGENT_TEMPLATES)[number]): string {
  return `${JSON.stringify({ template: { ...template, instructions: undefined }, instructions: template.instructions, skills: {} }, null, 2)}\n\n--- INSTRUCTIONS.md ---\n\n# ${template.name}\n\n${template.instructions}\n`;
}

export function AgentTemplatesCatalog({ onUse }: { onUse: (template: (typeof AGENT_TEMPLATES)[number]) => Promise<void> }): JSX.Element {
  const [category, setCategory] = useState("all");
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [myTemplates, setMyTemplates] = useState<(typeof AGENT_TEMPLATES)[number][]>([]);
  const [myLoading, setMyLoading] = useState(false);
  const categories = ["all", "product", "engineering", "ops", "competitor-inspired", "my"];
  useEffect(() => {
    if (category !== "my") return;
    setMyLoading(true);
    fetch("/api/custom-agents").then(async (response) => {
      if (!response.ok) throw new Error("Your saved bots could not be loaded.");
      const body = await response.json() as { agents?: { slug: string; config: { name: string; instructions: string; emoji?: string; harness?: string } }[] };
      setMyTemplates((body.agents ?? []).filter((agent) => agent.config.instructions).map((agent) => ({
        id: agent.slug, name: agent.config.name, description: "Saved bot from your workspace.", categories: ["my"],
        appearance: agent.config.emoji, skills: [], plugins: [], harness: agent.config.harness ?? "opencode", chat_lanes: ["slack"], version: "1.0.0", instructions: agent.config.instructions,
      })));
      setMessage("");
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Your saved bots could not be loaded.")).finally(() => setMyLoading(false));
  }, [category]);
  const visible = useMemo(() => category === "my" ? myTemplates : AGENT_TEMPLATES.filter((item) => category === "all" || item.categories.includes(category)), [category, myTemplates]);

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
      await onUse(template);
      setMessage(`${template.name} added to your bots. Review its instructions before starting a task.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create bot from template."); }
    finally { setBusy(false); }
  };
  const importPack = async () => {
    try {
      const [jsonBlock, markdown] = importText.split("\n\n--- INSTRUCTIONS.md ---\n", 2);
      const parsed = JSON.parse(jsonBlock ?? "") as { template?: unknown; instructions?: unknown };
      const instructions = markdown?.trim().replace(/^# [^\n]+\n\n/, "") ?? parsed.instructions;
      const metadata = validateAgentTemplate({ ...(parsed.template as object), instructions });
      setBusy(true);
      const slug = metadata.id.slice(0, 48);
      const response = await fetch("/api/custom-agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, config: { name: metadata.name, instructions: metadata.instructions, harness: metadata.harness ?? "opencode", ...(metadata.appearance ? { emoji: metadata.appearance } : {}) } }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Import failed (${response.status}).`);
      setMessage(`${metadata.name} imported as a bot.`);
      setImportText("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Paste a valid Shiba template pack."); }
    finally { setBusy(false); }
  };

  return <section aria-label="Agent template marketplace" className="border border-[var(--border-1)] bg-[var(--card)] p-4">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-base font-semibold text-[var(--fg)]">Template catalog</h2><p className="text-xs text-[var(--muted-foreground-2)]">Original Shiba packs · Slack-first · {AGENT_TEMPLATES.length} templates</p></div>
      <select aria-label="Template category" value={category} onChange={(event) => setCategory(event.target.value)} className="border border-[var(--border-1)] bg-[var(--bg)] p-2 text-xs">{categories.map((item) => <option key={item} value={item}>{item === "all" ? "All templates" : item}</option>)}</select></div>
    {message ? <p role="status" className="mt-3 text-xs text-[var(--muted-foreground-2)]">{message}</p> : null}
    {myLoading ? <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">Loading your saved bots…</p> : null}
    {category === "my" && !myLoading && visible.length === 0 ? <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">No saved bots yet. Use an official template or create a bot to see it here.</p> : null}
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{visible.map((template) => <article key={template.id} className="border border-[var(--border-1)] p-3">
      <div className="flex justify-between gap-2"><h3 className="text-sm font-semibold">{template.appearance ?? "🤖"} {template.name}</h3><span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">v{template.version}</span></div>
      <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">{template.description}</p><div className="mt-2 flex flex-wrap gap-1">{template.categories.map((tag) => <span key={tag} className="border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[9px]">{tag}</span>)}</div>
      <div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => void clone(template)} className="border border-[var(--primary)] bg-[var(--primary)] px-2 py-1 text-xs text-white disabled:opacity-50">Use</button><button type="button" onClick={() => void copy(template)} className="border border-[var(--border-1)] px-2 py-1 text-xs">Copy pack</button></div>
    </article>)}</div>
    <details className="mt-4 border-t border-[var(--border-1)] pt-3"><summary className="cursor-pointer text-xs font-semibold">Paste import</summary><p className="my-2 text-xs text-[var(--muted-foreground-2)]">Paste a copied Shiba JSON pack to create a bot. Review its instructions before starting a task.</p><textarea aria-label="Template pack JSON" value={importText} onChange={(event) => setImportText(event.target.value)} rows={5} className="w-full border border-[var(--border-1)] bg-[var(--bg)] p-2 font-mono text-xs" placeholder="Paste template pack JSON"/><button type="button" disabled={busy || !importText.trim()} onClick={() => void importPack()} className="mt-2 border border-[var(--primary)] px-3 py-1.5 text-xs disabled:opacity-50">{busy ? "Importing…" : "Create bot from pack"}</button></details>
  </section>;
}
