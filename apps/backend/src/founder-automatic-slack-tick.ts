import type { Env } from "./env.js";
import {
  automaticReadReportAuthorityGuard,
  loadAutomaticReadReportAuthority,
  type AutomaticReportAuthority,
} from "./founder-auto-read-runtime.js";
import { readSlackInstallationCredential } from "./slack-installations-store.js";
import { verifySlackInstallationBot } from "./slack-installations-oauth.js";
import { postReportSlackMessage } from "./report-slack-sender.js";
import { SlackPostRejectedError } from "./slack.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";
import {
  ensureAutomaticSlackSchema,
  automaticSlackAvailable,
  automaticSlackGrantGuard,
  automaticSlackLink,
  assertAutomaticSlackFamilyCode,
  packAutomaticSlackGuard,
  renderAutomaticSlackReport,
  automaticSlackApprover,
  automaticSlackFamily,
  automaticSlackContentHash,
  type AutomaticSlackRow,
  type AutomaticSlackDeliveryRow,
  type AutomaticSlackGuard,
} from "./founder-automatic-slack-store.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";

export interface AutomaticSlackTickDeps {
  verifyInstallation?: typeof verifySlackInstallationBot;
  postMessage?: typeof postReportSlackMessage;
}
function deliverySource(
  env: Env,
  row: AutomaticSlackRow,
  a: AutomaticReportAuthority,
): AutomaticSlackGuard {
  const standing = automaticSlackGrantGuard(env, row, undefined, true),
    source = automaticReadReportAuthorityGuard(env, a);
  return packAutomaticSlackGuard({
    sql: `${standing.sql} AND ${source.sql} AND EXISTS(SELECT 1 FROM founder_automatic_read_occurrences WHERE id=? AND state='completed' AND scheduled_at>? AND grant_digest=?)`,
    values: [
      ...standing.values,
      ...source.values,
      a.occurrence.id,
      row.approved_at,
      row.read_grant_digest,
    ],
  });
}
function syncCurrent(
  env: Env,
  row: AutomaticSlackRow,
  a: AutomaticReportAuthority,
  deadline: number,
) {
  const selected = automaticSlackLink(row).destination.installation,
    approved = row.approver_json ? (JSON.parse(row.approver_json) as WorkspaceNativeMember) : null,
    now = Date.now();
  return (
    !automaticSlackAvailable(env) &&
    approved &&
    automaticSlackApprover(env, approved) &&
    selected &&
    now < deadline &&
    now < row.expires_at &&
    now < a.report.expiresAt &&
    now < JSON.parse(automaticSlackFamily(row).grant.contract_json).expiresAt &&
    (selected.expiresAt === null || now < selected.expiresAt)
  );
}
/** Bounded scheduler only. Human consent is a stored reference, never a fabricated session. */
export async function tickFounderAutomaticSlack(
  env: Env,
  deps: AutomaticSlackTickDeps = {},
): Promise<{ sent: number; blocked: number; unknown: number; unavailable: string | null }> {
  const unavailable = automaticSlackAvailable(env);
  if (unavailable) return { sent: 0, blocked: 0, unknown: 0, unavailable };
  await ensureAutomaticSlackSchema(env);
  // An orphaned send is never replayed. An active bounded send is not reclaimed early.
  await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `UPDATE founder_automatic_slack_deliveries SET state='unknown',error_code='automatic_slack_receipt_unknown' WHERE state='sending' AND lease_expires_at<=${FOUNDER_SQL_NOW}`,
    ).bind(),
    env.AGENT_AUDIT.prepare(
      "UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_delivery_requires_inspection' WHERE state IN ('enabled','exhausted') AND EXISTS(SELECT 1 FROM founder_automatic_slack_deliveries d WHERE d.destination_key=founder_automatic_slack_grants.destination_key AND d.state='unknown')",
    ).bind(),
  ]);
  const grants = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM founder_automatic_slack_grants WHERE state='enabled' ORDER BY created_at,id LIMIT 2",
  ).all<AutomaticSlackRow>();
  let sent = 0,
    blocked = 0,
    unknown = 0;
  for (const row of grants.results) {
    let a: AutomaticReportAuthority;
    try {
      if (row.approved_at === null) throw new Error();
      await assertAutomaticSlackFamilyCode(row);
      const eligible =
        await env.AGENT_AUDIT.prepare(`SELECT id FROM founder_automatic_read_occurrences o WHERE o.grant_id=? AND o.grant_version=? AND o.grant_digest=? AND o.state='completed' AND o.scheduled_at>? AND o.expires_at>${FOUNDER_SQL_NOW}
        AND NOT EXISTS(SELECT 1 FROM founder_automatic_slack_deliveries d WHERE d.occurrence_id=o.id AND d.destination_key=?) ORDER BY o.scheduled_at LIMIT 1`)
          .bind(
            row.read_grant_id,
            row.read_grant_version,
            row.read_grant_digest,
            row.approved_at,
            row.destination_key,
          )
          .first<{ id: string }>();
      if (!eligible) continue;
      a = await loadAutomaticReadReportAuthority(env, {
        kind: "schedule",
        grantId: row.read_grant_id,
        grantVersion: row.read_grant_version,
        occurrenceId: eligible.id,
      });
      if (
        a.occurrence.state !== "completed" ||
        a.occurrence.scheduled_at <= row.approved_at ||
        a.readGrant.digest !== row.read_grant_digest
      )
        throw new Error();
      const content = renderAutomaticSlackReport(a.report.markdown),
        contentHash = await automaticSlackContentHash(content),
        sourceKey = await hashToolArgs({
          occurrenceId: a.occurrence.id,
          destinationKey: row.destination_key,
        });
      const now = Date.now(),
        deadline = Math.min(now + 30000, row.expires_at, a.report.expiresAt),
        id = `asdl_${crypto.randomUUID().replaceAll("-", "")}`,
        leaseId = crypto.randomUUID(),
        clientMsgId = crypto.randomUUID(),
        source = deliverySource(env, row, a);
      if (!syncCurrent(env, row, a, deadline)) throw new Error();
      const claimed = await env.AGENT_AUDIT.batch([
        env.AGENT_AUDIT.prepare(`UPDATE founder_automatic_slack_grants SET used_sends=used_sends+1,state=CASE WHEN used_sends+1>=max_sends THEN 'exhausted' ELSE 'enabled' END WHERE id=? AND digest=? AND state='enabled' AND used_sends=? AND used_sends<max_sends AND approver_json=? AND approved_at=? AND ${source.sql}
          AND NOT EXISTS(SELECT 1 FROM founder_automatic_slack_deliveries WHERE destination_key=? AND (state IN ('sending','unknown') OR source_key=?))`).bind(
          row.id,
          row.digest,
          row.used_sends,
          row.approver_json,
          row.approved_at,
          ...source.values,
          row.destination_key,
          sourceKey,
        ),
        env.AGENT_AUDIT.prepare(
          "INSERT INTO founder_automatic_slack_deliveries(id,grant_id,workspace_id,occurrence_id,source_key,destination_key,report_hash,content,content_hash,client_msg_id,state,lease_id,lease_expires_at,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,'sending',?,?,?,? WHERE changes()=1",
        ).bind(
          id,
          row.id,
          row.workspace_id,
          a.occurrence.id,
          sourceKey,
          row.destination_key,
          a.report.reportHash,
          content,
          contentHash,
          clientMsgId,
          leaseId,
          deadline,
          now,
          Math.min(row.expires_at, a.report.expiresAt),
        ),
      ]);
      if (claimed[0]?.meta.changes !== 1) {
        // A stale source must not occupy the bounded due scan forever. A healthy
        // concurrent claim keeps its grant: only a freshly false authority fence blocks it.
        const invalid = await env.AGENT_AUDIT.prepare(
          `UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_source_or_destination_changed'
            WHERE id=? AND digest=? AND state='enabled' AND NOT (${source.sql})`,
        )
          .bind(row.id, row.digest, ...source.values)
          .run();
        if (invalid.meta.changes === 1) blocked++;
        continue;
      }
      let state: AutomaticSlackDeliveryRow["state"] = "blocked",
        receipt: string | null = null,
        error = "automatic_slack_preflight_failed",
        dispatched = false;
      try {
        const selected = automaticSlackLink(row).destination.installation;
        if (!selected) throw new Error();
        const { token } = await readSlackInstallationCredential(env, selected),
          verified = await (deps.verifyInstallation ?? verifySlackInstallationBot)(token);
        if (
          verified.teamId !== selected.teamId ||
          verified.userId !== selected.botUserId ||
          verified.botId !== selected.botId
        )
          throw new Error();
        // Report/source/installation/native policy may change during auth.test or crypto awaits.
        const fresh = await loadAutomaticReadReportAuthority(env, {
          kind: "schedule",
          grantId: row.read_grant_id,
          grantVersion: row.read_grant_version,
          occurrenceId: a.occurrence.id,
        });
        await assertAutomaticSlackFamilyCode(row);
        if (
          fresh.report.reportHash !== a.report.reportHash ||
          renderAutomaticSlackReport(fresh.report.markdown) !== content
        )
          throw new Error();
        const finalSource = deliverySource(env, row, fresh);
        const final =
          await env.AGENT_AUDIT.prepare(`SELECT 1 AS current FROM founder_automatic_slack_deliveries d WHERE d.id=? AND d.state='sending' AND d.lease_id=? AND d.content_hash=? AND d.content=? AND d.report_hash=? AND d.lease_expires_at>${FOUNDER_SQL_NOW} AND d.expires_at>${FOUNDER_SQL_NOW} AND ${finalSource.sql}
          AND EXISTS(SELECT 1 FROM founder_automatic_slack_grants g WHERE g.id=? AND g.digest=? AND g.state IN ('enabled','exhausted') AND g.approver_json=? AND g.approved_at=? AND g.used_sends=? AND g.used_sends<=g.max_sends)
          AND NOT EXISTS(SELECT 1 FROM founder_automatic_slack_deliveries other WHERE other.destination_key=d.destination_key AND other.id<>d.id AND other.state IN ('sending','unknown'))`)
            .bind(
              id,
              leaseId,
              contentHash,
              content,
              a.report.reportHash,
              ...finalSource.values,
              row.id,
              row.digest,
              row.approver_json,
              row.approved_at,
              row.used_sends + 1,
            )
            .first();
        if (!final || !syncCurrent(env, row, fresh, deadline)) throw new Error();
        // No await between the last local source/time fence and this one fixed Slack POST.
        dispatched = true;
        const destination = automaticSlackLink(row).destination;
        const response = await (deps.postMessage ?? postReportSlackMessage)(token, {
          channel: destination.channelId,
          threadTs: destination.threadTs,
          text: content,
          clientMsgId,
        });
        if (response.channel !== destination.channelId || !/^\d{1,20}\.\d{1,20}$/.test(response.ts))
          throw new Error();
        state = "sent";
        receipt = response.ts;
        error = "";
      } catch (caught) {
        state = dispatched
          ? caught instanceof SlackPostRejectedError && caught.outcomeKnown
            ? "failed"
            : "unknown"
          : "blocked";
        error =
          state === "unknown"
            ? "automatic_slack_outcome_unknown"
            : state === "failed"
              ? "automatic_slack_rejected"
              : "automatic_slack_preflight_failed";
      }
      // Losing this receipt leaves 'sending'; the expired lease later becomes unknown, never replayed.
      const saved = await env.AGENT_AUDIT.prepare(
        "UPDATE founder_automatic_slack_deliveries SET state=?,receipt_ts=?,error_code=? WHERE id=? AND lease_id=? AND state='sending'",
      )
        .bind(state, receipt, error || null, id, leaseId)
        .run();
      if (saved.meta.changes !== 1) {
        unknown++;
        continue;
      }
      if (state === "sent") sent++;
      else if (state === "unknown") unknown++;
      else blocked++;
      if (state !== "sent")
        await env.AGENT_AUDIT.prepare(
          "UPDATE founder_automatic_slack_grants SET state='blocked',error_code=? WHERE id=? AND state IN ('enabled','exhausted')",
        )
          .bind(error, row.id)
          .run();
    } catch {
      await env.AGENT_AUDIT.prepare(
        "UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_source_or_render_changed' WHERE id=? AND state='enabled'",
      )
        .bind(row.id)
        .run();
      blocked++;
    }
  }
  return { sent, blocked, unknown, unavailable: null };
}
