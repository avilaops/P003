DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON fiscal_outgoing_nfse_issuances,fiscal_outgoing_nfse_sequences TO erp_next_app;
        GRANT SELECT,INSERT ON fiscal_outgoing_nfse_events TO erp_next_app;
    END IF;
END $$;
