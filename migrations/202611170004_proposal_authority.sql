ALTER TABLE sales_proposal_versions ADD COLUMN commercial_approval jsonb
 CHECK(commercial_approval IS NULL OR jsonb_typeof(commercial_approval)='object');
ALTER TABLE sales_order_lines ADD COLUMN technical_snapshot jsonb
 CHECK(technical_snapshot IS NULL OR jsonb_typeof(technical_snapshot)='object');

CREATE FUNCTION preserve_proposal_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'draft' AND OLD.commercial_approval IS NOT NULL
  AND NEW.commercial_approval IS DISTINCT FROM OLD.commercial_approval THEN
  RAISE EXCEPTION 'Published proposal approval is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER proposal_approval_immutable BEFORE UPDATE ON sales_proposal_versions
 FOR EACH ROW EXECUTE FUNCTION preserve_proposal_approval();
