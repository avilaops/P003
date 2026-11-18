-- Legacy inventory counts and commercial returns record their document in stock.moved audit details.
CREATE INDEX audit_stock_movement_origin_idx ON audit_log (tenant_id, entity_id)
  WHERE entity_type='stock_movement' AND action='stock.moved'
    AND (details ? 'inventoryCountId' OR details ? 'sourceId');
