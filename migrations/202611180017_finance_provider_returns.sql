ALTER TABLE finance_collection_imports
  ADD COLUMN account_id uuid,
  ADD COLUMN collector_id text,
  ADD COLUMN live_mode boolean,
  ADD COLUMN report_id text,
  ADD COLUMN file_name text,
  ADD COLUMN content_sha256 text,
  ADD COLUMN csv_content text,
  ADD FOREIGN KEY (tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id),
  ADD UNIQUE(tenant_id,account_id,collector_id,live_mode,report_id),
  ADD CHECK ((report_id IS NULL AND account_id IS NULL AND collector_id IS NULL AND live_mode IS NULL AND file_name IS NULL AND content_sha256 IS NULL AND csv_content IS NULL)
    OR (report_id IS NOT NULL AND account_id IS NOT NULL AND collector_id IS NOT NULL AND live_mode IS NOT NULL AND file_name IS NOT NULL AND content_sha256 IS NOT NULL
      AND octet_length(csv_content)<=2000000 AND (csv_content IS NOT NULL OR result IS NOT NULL)));
