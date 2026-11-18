CREATE TABLE finance_cost_center_distributions (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    PRIMARY KEY (tenant_id,id)
);
CREATE TABLE finance_cost_center_shares (
    tenant_id uuid NOT NULL,
    distribution_id uuid NOT NULL,
    cost_center_id uuid NOT NULL,
    basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 9999),
    PRIMARY KEY (tenant_id,distribution_id,cost_center_id),
    FOREIGN KEY (tenant_id,distribution_id) REFERENCES finance_cost_center_distributions(tenant_id,id),
    FOREIGN KEY (tenant_id,cost_center_id) REFERENCES financial_cost_centers(tenant_id,id)
);
CREATE FUNCTION finance_check_cost_center_distribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE group_id uuid := coalesce((to_jsonb(NEW)->>'distribution_id')::uuid,(to_jsonb(NEW)->>'id')::uuid);
BEGIN
    IF (SELECT coalesce(sum(basis_points),0) FROM finance_cost_center_shares
        WHERE tenant_id=NEW.tenant_id AND distribution_id=group_id) <> 10000 THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='A distribuição entre centros deve somar 100%';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER finance_complete_distribution
AFTER INSERT ON finance_cost_center_distributions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance_check_cost_center_distribution();
CREATE CONSTRAINT TRIGGER finance_complete_shares
AFTER INSERT ON finance_cost_center_shares DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance_check_cost_center_distribution();
DO $$ DECLARE target text; BEGIN
    FOREACH target IN ARRAY ARRAY['receivables','payables','receivable_payments','payable_payments','financial_account_entries'] LOOP
        EXECUTE format('ALTER TABLE %I ADD cost_center_distribution_id uuid, ADD FOREIGN KEY(tenant_id,cost_center_distribution_id) REFERENCES finance_cost_center_distributions(tenant_id,id), ADD CHECK (num_nonnulls(cost_center_id,cost_center_distribution_id)<=1)',target);
    END LOOP;
END $$;
ALTER TABLE receivable_payments ADD UNIQUE (tenant_id,id,cost_center_distribution_id);
ALTER TABLE payable_payments ADD UNIQUE (tenant_id,id,cost_center_distribution_id);
CREATE TABLE financial_payment_allocations (
    tenant_id uuid NOT NULL,
    distribution_id uuid NOT NULL,
    cost_center_id uuid NOT NULL,
    receivable_payment_id uuid,
    payable_payment_id uuid,
    principal_cents bigint NOT NULL CHECK(principal_cents>=0),
    interest_cents bigint NOT NULL CHECK(interest_cents>=0),
    penalty_cents bigint NOT NULL CHECK(penalty_cents>=0),
    surcharge_cents bigint NOT NULL CHECK(surcharge_cents>=0),
    discount_cents bigint NOT NULL CHECK(discount_cents>=0),
    net_cents bigint GENERATED ALWAYS AS (principal_cents+interest_cents+penalty_cents+surcharge_cents-discount_cents) STORED,
    CHECK (num_nonnulls(receivable_payment_id,payable_payment_id)=1),
    CHECK (principal_cents+interest_cents+penalty_cents+surcharge_cents>=discount_cents),
    UNIQUE(tenant_id,receivable_payment_id,cost_center_id), UNIQUE(tenant_id,payable_payment_id,cost_center_id),
    FOREIGN KEY(tenant_id,receivable_payment_id,distribution_id) REFERENCES receivable_payments(tenant_id,id,cost_center_distribution_id),
    FOREIGN KEY(tenant_id,payable_payment_id,distribution_id) REFERENCES payable_payments(tenant_id,id,cost_center_distribution_id),
    FOREIGN KEY(tenant_id,distribution_id,cost_center_id) REFERENCES finance_cost_center_shares(tenant_id,distribution_id,cost_center_id)
);
CREATE FUNCTION finance_check_payment_allocations() RETURNS trigger LANGUAGE plpgsql AS $verify$
DECLARE totals record;
BEGIN
    SELECT count(*) AS members,sum(principal_cents)::bigint AS principal,sum(interest_cents)::bigint AS interest,
           sum(penalty_cents)::bigint AS penalty,sum(surcharge_cents)::bigint AS surcharge,sum(discount_cents)::bigint AS discount
      INTO totals FROM financial_payment_allocations
     WHERE tenant_id=NEW.tenant_id AND distribution_id=NEW.cost_center_distribution_id
       AND CASE TG_TABLE_NAME WHEN 'receivable_payments' THEN receivable_payment_id ELSE payable_payment_id END=NEW.id;
    IF totals.members<>(SELECT count(*) FROM finance_cost_center_shares WHERE tenant_id=NEW.tenant_id AND distribution_id=NEW.cost_center_distribution_id)
        OR ROW(totals.principal,totals.interest,totals.penalty,totals.surcharge,totals.discount)
          IS DISTINCT FROM ROW(NEW.amount_cents,NEW.interest_cents,NEW.penalty_cents,NEW.surcharge_cents,NEW.discount_cents) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Os valores do rateio precisam fechar com a baixa';
    END IF;
    RETURN NULL;
END $verify$;
CREATE CONSTRAINT TRIGGER finance_complete_receivable_allocation AFTER INSERT ON receivable_payments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.cost_center_distribution_id IS NOT NULL)
EXECUTE FUNCTION finance_check_payment_allocations();
CREATE CONSTRAINT TRIGGER finance_complete_payable_allocation AFTER INSERT ON payable_payments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.cost_center_distribution_id IS NOT NULL)
EXECUTE FUNCTION finance_check_payment_allocations();
CREATE INDEX financial_allocations_distribution ON financial_payment_allocations(tenant_id,distribution_id,cost_center_id);
DO $$ DECLARE target text; BEGIN
    FOREACH target IN ARRAY ARRAY['finance_cost_center_distributions','finance_cost_center_shares','financial_payment_allocations'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',target);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',target);
        EXECUTE format('CREATE TRIGGER finance_allocation_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes()',target);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',target);
        END IF;
    END LOOP;
END $$;
