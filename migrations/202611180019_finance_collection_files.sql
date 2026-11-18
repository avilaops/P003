CREATE TABLE finance_collection_file_profiles (
    tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL,
    beneficiary_code text NOT NULL CHECK (beneficiary_code ~ '^[0-9]{9}$'),
    profile jsonb NOT NULL CHECK (profile->>'beneficiaryCode'=beneficiary_code),
    active boolean NOT NULL DEFAULT true,
    -- The extra value represents an exhausted sequence and cannot be issued.
    next_sequence integer NOT NULL CHECK (next_sequence BETWEEN 1 AND 1000000),
    next_our_number bigint NOT NULL CHECK (next_our_number BETWEEN 1 AND 1000000000000),
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,account_id,beneficiary_code), UNIQUE (tenant_id,id,account_id),
    FOREIGN KEY (tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id)
);
CREATE UNIQUE INDEX finance_collection_file_active ON finance_collection_file_profiles(tenant_id,account_id) WHERE active;
CREATE UNIQUE INDEX finance_collection_file_source ON finance_collection_file_profiles(
    tenant_id,beneficiary_code,(profile->>'taxId'),(profile->>'agency'),(profile->>'agencyDigit'),(profile->>'account'),(profile->>'accountDigit')
);

CREATE TABLE finance_collection_remittances (
    tenant_id uuid NOT NULL, id uuid NOT NULL, batch_id uuid NOT NULL, account_id uuid NOT NULL, profile_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 999999), profile_snapshot jsonb NOT NULL,
    filename text NOT NULL, content text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 250), amount_cents numeric(20,0) NOT NULL CHECK (amount_cents>0),
    created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,batch_id), UNIQUE (tenant_id,profile_id,sequence),
    UNIQUE (tenant_id,id,batch_id,profile_id),
    FOREIGN KEY (tenant_id,batch_id,account_id) REFERENCES finance_collection_batches(tenant_id,id,account_id),
    FOREIGN KEY (tenant_id,profile_id,account_id) REFERENCES finance_collection_file_profiles(tenant_id,id,account_id)
);
CREATE INDEX finance_collection_remittance_history ON finance_collection_remittances(tenant_id,account_id,created_at DESC,id DESC);
CREATE TABLE finance_collection_remittance_items (
    tenant_id uuid NOT NULL, remittance_id uuid NOT NULL, batch_id uuid NOT NULL, profile_id uuid NOT NULL, receivable_id uuid NOT NULL,
    our_number text NOT NULL CHECK (our_number ~ '^[0-9]{13}$'), document_number text NOT NULL, control_number text NOT NULL,
    payer_tax_id text NOT NULL, state text NOT NULL DEFAULT 'remitted' CHECK (state IN ('remitted','registered','rejected','paid','review','reversed')),
    payment_id uuid, reversal_id uuid, fee_entry_id uuid, settled_at timestamptz, review_reason text,
    PRIMARY KEY (tenant_id,profile_id,our_number), UNIQUE (tenant_id,batch_id,receivable_id),
    UNIQUE (tenant_id,profile_id,our_number,receivable_id), UNIQUE (tenant_id,fee_entry_id), UNIQUE (tenant_id,payment_id), UNIQUE (tenant_id,reversal_id),
    CHECK ((state IN ('paid','reversed'))=(payment_id IS NOT NULL) AND (state='reversed')=(reversal_id IS NOT NULL)
       AND (payment_id IS NULL)=(settled_at IS NULL) AND (fee_entry_id IS NULL OR payment_id IS NOT NULL)),
    FOREIGN KEY (tenant_id,remittance_id,batch_id,profile_id) REFERENCES finance_collection_remittances(tenant_id,id,batch_id,profile_id),
    FOREIGN KEY (tenant_id,batch_id,receivable_id) REFERENCES finance_collection_batch_items(tenant_id,batch_id,receivable_id),
    FOREIGN KEY (tenant_id,receivable_id,payment_id) REFERENCES receivable_payments(tenant_id,receivable_id,id),
    FOREIGN KEY (tenant_id,receivable_id,reversal_id) REFERENCES receivable_payments(tenant_id,receivable_id,id),
    FOREIGN KEY (tenant_id,fee_entry_id) REFERENCES financial_account_entries(tenant_id,id)
);
CREATE TABLE finance_collection_returns (
    tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, profile_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 999999), generated_on date NOT NULL,
    filename text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), content text NOT NULL CHECK (octet_length(content)<=2000000),
    item_count integer NOT NULL CHECK (item_count>=0), created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,id,profile_id), UNIQUE (tenant_id,profile_id,sequence), UNIQUE (tenant_id,account_id,sha256),
    FOREIGN KEY (tenant_id,profile_id,account_id) REFERENCES finance_collection_file_profiles(tenant_id,id,account_id)
);
CREATE INDEX finance_collection_return_history ON finance_collection_returns(tenant_id,account_id,created_at DESC,id DESC);
CREATE TABLE finance_collection_return_events (
    tenant_id uuid NOT NULL, return_id uuid NOT NULL, ordinal integer NOT NULL CHECK (ordinal>0), profile_id uuid NOT NULL, receivable_id uuid,
    our_number text NOT NULL, occurrence text NOT NULL, event_sha256 text NOT NULL, evidence jsonb NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('registered','rejected','paid','review','unknown','duplicate')), reason text,
    PRIMARY KEY (tenant_id,return_id,ordinal),
    FOREIGN KEY (tenant_id,return_id,profile_id) REFERENCES finance_collection_returns(tenant_id,id,profile_id),
    FOREIGN KEY (tenant_id,profile_id,our_number,receivable_id) REFERENCES finance_collection_remittance_items(tenant_id,profile_id,our_number,receivable_id)
);
CREATE UNIQUE INDEX finance_collection_accepted_occurrence ON finance_collection_return_events(tenant_id,profile_id,our_number,occurrence)
    WHERE outcome IN ('paid','registered','rejected');
CREATE INDEX finance_collection_return_item_history ON finance_collection_return_events(tenant_id,receivable_id,return_id);
DO $privileges$
DECLARE tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['finance_collection_file_profiles','finance_collection_remittances','finance_collection_remittance_items','finance_collection_returns','finance_collection_return_events'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
        IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',tbl);
        END IF;
    END LOOP;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT UPDATE(profile,active,next_sequence,next_our_number) ON finance_collection_file_profiles TO erp_next_app;
        GRANT UPDATE(state,payment_id,reversal_id,fee_entry_id,settled_at,review_reason) ON finance_collection_remittance_items TO erp_next_app;
    END IF;
END $privileges$;
