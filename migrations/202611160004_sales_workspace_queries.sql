-- Recent records are ordered by their last update within the selected tenant.
CREATE INDEX sales_orders_tenant_updated_idx
    ON sales_orders(tenant_id, updated_at DESC, id DESC);
CREATE INDEX sales_proposals_tenant_updated_idx
    ON sales_proposals(tenant_id, updated_at DESC, id DESC);

-- Draft totals cover all matching orders, independently of the page limit.
CREATE INDEX sales_orders_tenant_status_idx ON sales_orders(tenant_id, status);
