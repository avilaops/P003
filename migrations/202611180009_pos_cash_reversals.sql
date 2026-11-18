ALTER TABLE pos_cash_movements
    ADD COLUMN reverses_movement_id uuid,
    ADD UNIQUE(tenant_id,session_id,id),
    ADD UNIQUE(tenant_id,reverses_movement_id),
    ADD FOREIGN KEY(tenant_id,session_id,reverses_movement_id) REFERENCES pos_cash_movements(tenant_id,session_id,id);
