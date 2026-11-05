import { useMemo, useState, type JSX } from "react";
import { AppWindow, Plug, Radio, Search, Server, Sparkles, X } from "lucide-react";
import {
  ContextPanel,
  PanelIconButton,
  PanelNavItem,
  type Scope,
} from "./ui/ContextPanel";

export interface ExtensionsPanelProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  onSearchClick?: () => void;
  className?: string;
}

interface ExtensionNavItem {
  id: string;
  label: string;
  icon: typeof Plug;
  match: (active: string) => boolean;
}

const EXTENSION_NAV_ITEMS: ExtensionNavItem[] = [
  {
    id: "integrations",
    label: "Connectors",
    icon: Plug,
    match: (active) => active === "integrations" || active === "connectors",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    match: (active) => active === "skills",
  },
  {
    id: "agents",
    label: "MCPs",
    icon: Server,
    match: (active) => active === "agents" || active === "mcp" || active === "mcps",
  },
  {
    id: "providers",
    label: "Providers",
    icon: Radio,
    match: (active) => active === "providers",
  },
  {
    id: "spaces",
    label: "Apps",
    icon: AppWindow,
    match: (active) => active === "spaces" || active === "apps",
  },
];

/**
 * ExtensionsPanel — secondary contextual panel for More > Extensions hub.
 * Provides scope switch (Personal | Workspace), search, and navigation between:
 * Connectors, Skills, MCPs, Providers, and Apps.
 */
export function ExtensionsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  onSearchClick,
  className = "",
}: ExtensionsPanelProps): JSX.Element {
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");

  const handleToggleSearch = () => {
    if (onSearchClick) {
      onSearchClick();
    } else {
      setShowSearch((prev) => !prev);
      if (showSearch) setQuery("");
    }
  };

  const filteredItems = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return EXTENSION_NAV_ITEMS;
    return EXTENSION_NAV_ITEMS.filter((item) =>
      item.label.toLowerCase().includes(trimmed)
    );
  }, [query]);

  return (
    <ContextPanel
      title="Extensions"
      scope={scope}
      onScopeChange={onScopeChange}
      actions={
        <PanelIconButton
          label="Search extensions"
          onClick={handleToggleSearch}
        >
          <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </PanelIconButton>
      }
      className={className}
    >
      <div className="flex flex-col gap-1 pt-1" data-testid="extensions-panel-nav">
        {showSearch ? (
          <div className="relative mb-2 px-0.5">
            <input
              type="search"
              aria-label="Filter extensions"
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: field is revealed by an explicit user action
              autoFocus
              className="h-8 w-full rounded-md border border-[#e4e4e7] bg-[#f4f4f5] px-2.5 text-xs text-[#0a0a0a] placeholder:text-[#71717a] focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                className="absolute right-2 top-2 text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        {filteredItems.map((item) => {
          const isCurrent = item.match(active);
          return (
            <PanelNavItem
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={isCurrent}
              onClick={() => onSelect(item.id)}
            />
          );
        })}

        {filteredItems.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-[#71717a] dark:text-zinc-500">
            No matching sections
          </p>
        ) : null}
      </div>
    </ContextPanel>
  );
}
