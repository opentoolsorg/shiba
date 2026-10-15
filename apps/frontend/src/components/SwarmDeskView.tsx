import { useMemo, useState, type JSX } from "react";
// eslint-disable-next-line no-restricted-imports
import {
  SWARM_LANES,
  formatRunAge,
  projectSwarmDesk,
  parseSwarmIntake,
  type SwarmCard,
  type SwarmLane,
  type SwarmMode,
  type SwarmRunInput,
} from "../../../../packages/shared/src/swarm-desk.js";
import { parseRepoName } from "../ui-helpers";

export interface SwarmDeskViewProps {
  runs: SwarmRunInput[];
  onApplyIntake: (prompt: string) => void;
  shareUrlFor: (runId: string) => Promise<string>;
  onResolve?: (runId: string) => Promise<void> | void;
}

const LANE_LABELS: Record<SwarmLane, string> = {
  backlog: "Backlog",
  in_progress: "In progress",
  needs_review: "Needs review",
  archived: "Archived",
};

const MODE_LABELS: Record<SwarmMode, string> = {
  captain: "Captain",
  build: "Build",
  review: "Review",
};

export function SwarmDeskView({
  runs,
  onApplyIntake,
  shareUrlFor,
  onResolve,
}: SwarmDeskViewProps): JSX.Element {
  const [intakeText, setIntakeText] = useState("");
  const [search, setSearch] = useState("");
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [resolveErrors, setResolveErrors] = useState<Record<string, string>>({});
  const [shareUrls, setShareUrls] = useState<Record<string, string>>({});
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({});
  const [sharingRunIds, setSharingRunIds] = useState<Record<string, boolean>>({});

  const parsedIntake = useMemo(() => parseSwarmIntake(intakeText), [intakeText]);
  const isApplyDisabled = !parsedIntake.prompt.trim();

  const desk = useMemo(() => projectSwarmDesk(runs), [runs]);
  const handleResolve = async (runId: string) => {
    if (!onResolve || resolving[runId]) return;
    setResolving((previous) => ({ ...previous, [runId]: true }));
    setResolveErrors((previous) => ({ ...previous, [runId]: "" }));
    try { await onResolve(runId); }
    catch (error) {
      setResolveErrors((previous) => ({ ...previous, [runId]: error instanceof Error ? error.message : String(error) }));
    } finally { setResolving((previous) => ({ ...previous, [runId]: false })); }
  };

  const handleApply = () => {
    if (isApplyDisabled) return;
    onApplyIntake(parsedIntake.prompt);
  };

  const handleShare = async (runId: string) => {
    setSharingRunIds((prev) => ({ ...prev, [runId]: true }));
    setShareErrors((prev) => {
      const next = { ...prev };
      delete next[runId];
      return next;
    });

    try {
      const url = await shareUrlFor(runId);
      setShareUrls((prev) => ({ ...prev, [runId]: url }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setShareErrors((prev) => ({ ...prev, [runId]: message }));
    } finally {
      setSharingRunIds((prev) => {
        const next = { ...prev };
        delete next[runId];
        return next;
      });
    }
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain bg-[#f6f4ed] text-[#222320]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-6">
        {/* Header row */}
        <div>
          <h2 className="text-lg font-semibold font-display tracking-tight text-[#222320]">
            Swarm desk
          </h2>
          <p className="text-xs text-[#6a6f63] mt-0.5">
            Backlog, in progress, needs review, archived. Threads queue here. Concurrent sandboxes stay capped by wrangler max_instances.
          </p>
        </div>

        {/* Intake composer */}
        <section className="bg-[#fffef8] border border-[#d3d2c8] rounded-none p-4 shadow-[2px_2px_0_var(--paper-shadow)] flex flex-col gap-3">
          <label htmlFor="swarm-intake-textarea" className="text-xs font-semibold text-[#222320]">
            Linear link, Sentry link, or a plain task
          </label>
          <textarea
            id="swarm-intake-textarea"
            value={intakeText}
            onChange={(e) => setIntakeText(e.target.value)}
            placeholder="Paste a Linear issue URL, Sentry issue link, or plain task description..."
            rows={3}
            className="w-full resize-y bg-[#f1efe6] border border-[#e0ded5] rounded-none p-2.5 text-xs font-mono text-[#222320] placeholder-[#6a6f63]/70 focus:outline-none focus:border-[#0000a8]/50 focus:ring-1 focus:ring-[#0000a8]/30 transition-colors motion-reduce:transition-none"
          />
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={handleApply}
              disabled={isApplyDisabled}
              className="primary-action min-h-9 rounded-none text-xs font-semibold px-4 py-1.5 flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors motion-reduce:transition-none"
            >
              Use as task
            </button>
          </div>
        </section>

        {/* Four lanes: stacked below lg, 4 columns from lg (1024px) */}
        <input
          type="search"
          aria-label="Search threads"
          placeholder="Search threads…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-full min-h-11 bg-[#fffef8] border border-[#d3d2c8] rounded-none px-3 text-sm text-[#222320] placeholder-[#6a6f63] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0000a8]"
        />
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
          {SWARM_LANES.map((lane) => {
            const cards: SwarmCard[] = desk[lane].filter((card) =>
              [card.title, card.repoUrl, card.runId, card.issueRef ?? ""].some((value) => value.toLowerCase().includes(search.trim().toLowerCase())),
            );
            const laneLabel = LANE_LABELS[lane];

            return (
              <section
                key={lane}
                aria-label={laneLabel}
                className="paper-window rounded-none overflow-hidden flex flex-col"
              >
                <header className="bez-titlebar">
                  <h3 className="text-[11px] font-mono tracking-[0.08em] uppercase">
                    {laneLabel}
                  </h3>
                  <span className="text-[10px] font-mono text-white/90">
                    {cards.length}
                  </span>
                </header>

                <div className="p-3 bg-[#fffef8] flex flex-col gap-3 min-h-[140px]">
                  {cards.length === 0 ? (
                    <div className="py-8 text-center text-xs text-[#6a6f63]">
                      Nothing in this lane.
                    </div>
                  ) : (
                    cards.map((card) => {
                      const shareUrl = shareUrls[card.runId];
                      const shareError = shareErrors[card.runId];
                      const isSharing = Boolean(sharingRunIds[card.runId]);
                      const modeLabel = MODE_LABELS[card.mode];
                      const repoName = parseRepoName(card.repoUrl);

                      return (
                        <article
                          key={card.runId}
                          className="bg-[#fffef8] border border-[#d3d2c8] rounded-none p-3 shadow-[2px_2px_0_var(--paper-shadow)] flex flex-col gap-2.5 transition-colors hover:border-[#0000a8]/30 motion-reduce:transition-none"
                        >
                          {/* Title */}
                          <h4 className="text-[13px] font-medium text-[#222320] leading-snug break-words">
                            {card.title}
                          </h4>
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#6a6f63]">
                            {card.issueRef ? <span className="font-mono border border-[#d3d2c8] px-1.5 py-0.5">{card.issueRef}</span> : null}
                            <span>{formatRunAge(card.updatedAt, Date.now())}</span>
                            {card.costUsd != null ? <span>${card.costUsd.toFixed(2)}</span> : null}
                          </div>

                          {/* Mode chip and Repo */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider border rounded-none px-2 py-0.5 text-[#0000a8] border-[#0000a8]/30 bg-[#0000a8]/10">
                              {modeLabel}
                            </span>
                            <span className="text-[11px] font-mono text-[#6a6f63] truncate">
                              {repoName}
                            </span>
                          </div>

                          {/* Screenshot preview if present */}
                          {typeof card.screenshotUrl === "string" && card.screenshotUrl.trim().length > 0 ? (
                            <div className="border border-[#e0ded5] overflow-hidden bg-[#f6f4ed]">
                              <img
                                src={card.screenshotUrl}
                                alt="Run preview"
                                className="w-full h-auto block object-cover"
                              />
                            </div>
                          ) : null}

                          {/* Share button & results */}
                          <div className="pt-1 border-t border-[#e0ded5] flex flex-col gap-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => handleShare(card.runId)}
                                disabled={isSharing}
                                className="text-[11px] font-mono font-medium text-[#1c1cc8] hover:text-[#0000a8] border border-[#e0ded5] hover:border-[#0000a8]/40 bg-[#fffef8] px-2.5 py-1 rounded-none transition-colors disabled:opacity-50 motion-reduce:transition-none"
                              >
                                {isSharing ? "Sharing..." : "Share"}
                              </button>
                              {lane === "needs_review" && onResolve ? (
                                <button type="button" onClick={() => handleResolve(card.runId)} disabled={Boolean(resolving[card.runId])}
                                  className="min-h-11 text-[11px] font-mono text-[#1c1cc8] border border-[#d3d2c8] px-2 rounded-none disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0000a8]">
                                  {resolving[card.runId] ? "Resolving..." : "Mark resolved"}
                                </button>
                              ) : null}
                            </div>

                            {shareUrl ? (
                              <div className="text-[11px] font-mono text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/30 px-2 py-1 rounded-none break-all select-all">
                                {shareUrl}
                              </div>
                            ) : null}

                            {shareError ? (
                              <div className="text-[11px] font-mono text-[#b91c1c] bg-[#fb2c36]/10 border border-[#fb2c36]/30 px-2 py-1 rounded-none break-all">
                                {shareError}
                              </div>
                            ) : null}
                            {resolveErrors[card.runId] ? <div role="alert" className="text-[11px] font-mono text-[#b91c1c] border border-[#fb2c36]/30 px-2 py-1 break-all">{resolveErrors[card.runId]}</div> : null}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
