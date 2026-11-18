-- Archiving keeps contract models, published versions, issued contracts, files and audit rows.
-- Production already received the columns and the read policies by a manual intervention on
-- 18/11/2026; this migration records them idempotently so every environment has the same schema.
ALTER TABLE commercial_contracts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE commercial_template_drafts ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Archived rows stay out of every ordinary read. Only a transaction that explicitly sets
-- app.include_archived (the archive command) can see them, which PostgreSQL requires to
-- check the new row of an UPDATE that sets archived_at.
DROP POLICY IF EXISTS commercial_contracts_active_read ON commercial_contracts;
CREATE POLICY commercial_contracts_active_read ON commercial_contracts AS RESTRICTIVE FOR SELECT
    USING (archived_at IS NULL OR current_setting('app.include_archived', true) = 'on');

DROP POLICY IF EXISTS commercial_template_drafts_active_read ON commercial_template_drafts;
CREATE POLICY commercial_template_drafts_active_read ON commercial_template_drafts AS RESTRICTIVE FOR SELECT
    USING (archived_at IS NULL OR current_setting('app.include_archived', true) = 'on');
