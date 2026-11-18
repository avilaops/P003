CREATE TABLE finance_collection_return_reviews (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    return_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal > 0),
    state text NOT NULL CHECK (state IN ('registered','rejected','paid','review','duplicate')),
    reason text,
    review_reason text NOT NULL CHECK (char_length(btrim(review_reason)) BETWEEN 3 AND 300),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,return_id,ordinal)
        REFERENCES finance_collection_return_events(tenant_id,return_id,ordinal)
);
CREATE INDEX finance_collection_review_history
    ON finance_collection_return_reviews(tenant_id,return_id,ordinal,created_at,id);
CREATE UNIQUE INDEX finance_collection_review_resolved
    ON finance_collection_return_reviews(tenant_id,return_id,ordinal) WHERE state <> 'review';

ALTER TABLE finance_collection_return_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_collection_return_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance_collection_return_reviews
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $privileges$
BEGIN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT ON finance_collection_return_reviews TO erp_next_app;
    END IF;
END $privileges$;
