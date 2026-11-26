-- Reconciliation schedules froze each provider grant's sealed credential into their grant JSON, so revoking the
-- grant left a copy at rest. Strip it, and fail live schedules closed: their digest covered the old JSON.
UPDATE founder_reconciliation_schedules
SET hub_grant_json = CASE WHEN json_valid(hub_grant_json) THEN json_remove(hub_grant_json, '$.ciphertext') ELSE hub_grant_json END,
    stripe_grant_json = CASE WHEN json_valid(stripe_grant_json) THEN json_remove(stripe_grant_json, '$.ciphertext') ELSE stripe_grant_json END,
    state = CASE WHEN state IN ('draft', 'enabled', 'paused') THEN 'blocked' ELSE state END,
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE (json_valid(hub_grant_json) AND json_extract(hub_grant_json, '$.ciphertext') IS NOT NULL)
   OR (json_valid(stripe_grant_json) AND json_extract(stripe_grant_json, '$.ciphertext') IS NOT NULL);

-- Reconciliation Slack grants pinned a clone of the schedule row, so the same copy sits inside family_json.
UPDATE founder_reconciliation_slack_grants
SET family_json = json_set(
      family_json,
      '$.schedule.hub_grant_json', CASE WHEN json_valid(json_extract(family_json, '$.schedule.hub_grant_json'))
        THEN json_remove(json_extract(family_json, '$.schedule.hub_grant_json'), '$.ciphertext') || '' ELSE json_extract(family_json, '$.schedule.hub_grant_json') END,
      '$.schedule.stripe_grant_json', CASE WHEN json_valid(json_extract(family_json, '$.schedule.stripe_grant_json'))
        THEN json_remove(json_extract(family_json, '$.schedule.stripe_grant_json'), '$.ciphertext') || '' ELSE json_extract(family_json, '$.schedule.stripe_grant_json') END),
    state = CASE WHEN state IN ('draft', 'disclosed', 'enabled', 'paused') THEN 'blocked' ELSE state END,
    error_code = CASE WHEN state IN ('draft', 'disclosed', 'enabled', 'paused') THEN 'credential_copy_scrubbed' ELSE error_code END
WHERE json_valid(family_json)
  AND (instr(COALESCE(json_extract(family_json, '$.schedule.hub_grant_json'), ''), '"ciphertext"') > 0
    OR instr(COALESCE(json_extract(family_json, '$.schedule.stripe_grant_json'), ''), '"ciphertext"') > 0);
