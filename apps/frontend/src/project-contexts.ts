import { useEffect, useState } from "react";

interface ProjectContext {
  id: string;
  name: string;
  purpose: string;
  defaultCustomAgentId: string | null;
  defaultHarness: string | null;
}

/** Fetch only after identity resolves; discard prior-owner and superseded responses. */
export function useProjectContexts(owner: string | null): ProjectContext[] {
  const [snapshot, setSnapshot] = useState<{ owner: string; projects: ProjectContext[] } | null>(null);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    let request = 0;
    const load = () => {
      const current = ++request;
      void fetch("/api/memory/projects", { credentials: "same-origin", cache: "no-store" })
        .then(async (response) => response.ok ? await response.json() as { projects?: ProjectContext[] } : { projects: [] })
        .then((body) => { if (active && current === request) setSnapshot({ owner, projects: Array.isArray(body.projects) ? body.projects : [] }); })
        .catch(() => { if (active && current === request) setSnapshot({ owner, projects: [] }); });
    };
    load();
    window.addEventListener("shiba:projects-updated", load);
    return () => { active = false; window.removeEventListener("shiba:projects-updated", load); };
  }, [owner]);
  return owner && snapshot?.owner === owner ? snapshot.projects : [];
}
