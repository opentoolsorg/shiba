import { useEffect, useRef, useState, type JSX } from "react";
import { INTEGRATION_SETUP_GUIDE, type FeaturedCatalogItem } from "@shiba/shared";

type SetupCatalog = { configured: false; items: FeaturedCatalogItem[]; setup: typeof INTEGRATION_SETUP_GUIDE };

function Logo({ item }: { item: FeaturedCatalogItem }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!item.logo || failed) return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--card-hover)] text-xs font-semibold">{item.name.charAt(0)}</span>;
  return <img src={item.logo} alt="" className="size-8 shrink-0 object-contain" onError={() => setFailed(true)} />;
}

/** Shown only while OpenConnector is not set up; renders nothing for a configured provider. */
export function IntegrationsSetupCard({ workspaceId }: { workspaceId?: string }): JSX.Element | null {
  const [catalog, setCatalog] = useState<SetupCatalog | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    void fetch(workspaceId ? "/api/workspace-integrations/catalog" : "/api/integrations/provider/catalog", { credentials: "same-origin", cache: "no-store", signal: controller.signal,
      ...(workspaceId ? { headers: { "X-Shiba-Workspace": workspaceId } } : {}),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as Partial<SetupCatalog>;
        if (!controller.signal.aborted && body.configured === false && Array.isArray(body.items) && body.setup) setCatalog(body as SetupCatalog);
      })
      .catch(() => { /* Directory below reports its own load errors. */ });
    return () => controller.abort();
  }, [workspaceId]);

  if (!catalog) return null;
  const openSetup = () => { cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); cardRef.current?.focus(); };
  return (
    <div className="space-y-4 border-b border-[var(--border-1)] px-4 py-4 lg:px-8">
      <section ref={cardRef} tabIndex={-1} aria-labelledby="integrations-setup-title" className="border border-[var(--border-1)] bg-[var(--card)] p-4">
        <h3 id="integrations-setup-title" className="text-sm font-semibold">{catalog.setup.title}</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-[var(--muted-foreground-2)]">
          {catalog.setup.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <a href={catalog.setup.docsUrl} className="mt-3 inline-block text-xs font-semibold text-[var(--primary)] underline">Setup guide</a>
      </section>
      <ul aria-label="Featured apps" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {catalog.items.map((item) => (
          <li key={item.id} data-testid={`featured-app-${item.id}`} className="flex items-start gap-3 border border-[var(--border-1)] bg-[var(--card)] p-3">
            <Logo item={item} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{item.name}</span>
                <span className="border border-[var(--border-1)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground-2)]">Needs setup</span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{item.description}</p>
              <button type="button" onClick={openSetup} aria-label={`Connect ${item.name}`} className="mt-2 min-h-11 border border-[var(--border-1)] px-3 text-xs font-semibold hover:bg-[var(--card-hover)] lg:min-h-8">Connect</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
