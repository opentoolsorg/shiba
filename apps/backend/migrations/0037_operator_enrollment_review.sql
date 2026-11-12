-- Review metadata only. There is deliberately no active/executable state.
CREATE TABLE IF NOT EXISTS operator_enrollment_reviews (
  id TEXT PRIMARY KEY,
  generation TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','revoked')),
  version INTEGER NOT NULL CHECK(version > 0),
  decision_account_id TEXT,
  decided_at INTEGER,
  revoked_at INTEGER,
  CHECK((state='proposed' AND decision_account_id IS NULL AND decided_at IS NULL AND revoked_at IS NULL)
    OR (state IN ('accepted','rejected') AND decision_account_id IS owner_account_id AND decided_at IS NOT NULL AND revoked_at IS NULL)
    OR (state='revoked' AND decision_account_id IS owner_account_id AND decided_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS operator_enrollment_reviews_owner
  ON operator_enrollment_reviews(owner_account_id,owner_id,created_at);
CREATE TRIGGER IF NOT EXISTS operator_enrollment_reviews_immutable
BEFORE UPDATE ON operator_enrollment_reviews
WHEN NEW.id IS NOT OLD.id OR NEW.generation IS NOT OLD.generation
  OR NEW.owner_id IS NOT OLD.owner_id OR NEW.owner_account_id IS NOT OLD.owner_account_id
  OR NEW.operator_id IS NOT OLD.operator_id OR NEW.proposal_json IS NOT OLD.proposal_json
  OR NEW.proposal_digest IS NOT OLD.proposal_digest OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable_operator_enrollment'); END;
CREATE TRIGGER IF NOT EXISTS operator_enrollment_reviews_monotonic
BEFORE UPDATE ON operator_enrollment_reviews
WHEN NEW.version != OLD.version + 1
  OR NOT ((OLD.state='proposed' AND NEW.state IN ('accepted','rejected','revoked'))
    OR (OLD.state='accepted' AND NEW.state='revoked'))
  OR (OLD.decided_at IS NOT NULL AND NEW.decided_at IS NOT OLD.decided_at)
BEGIN SELECT RAISE(ABORT, 'invalid_operator_enrollment_transition'); END;
CREATE TRIGGER IF NOT EXISTS operator_enrollment_reviews_retain
BEFORE DELETE ON operator_enrollment_reviews
BEGIN SELECT RAISE(ABORT, 'retain_operator_enrollment_tombstone'); END;
