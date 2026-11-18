ALTER TABLE automation_workflow_runs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'normal' CHECK (outcome IN ('normal', 'quiet', 'failed'));
ALTER TABLE automation_workflow_runs ADD COLUMN failure_reason TEXT;
ALTER TABLE automation_workflow_runs ADD COLUMN answer_summary TEXT;
