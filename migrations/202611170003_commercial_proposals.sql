-- A proposal freezes the same commercial calculation consumed by its order.
ALTER TABLE sales_proposal_versions
 ADD COLUMN commercial_public jsonb CHECK(commercial_public IS NULL OR jsonb_typeof(commercial_public)='object'),
 ADD COLUMN commercial_private jsonb CHECK(commercial_private IS NULL OR jsonb_typeof(commercial_private)='object'),
 ADD COLUMN customer_snapshot jsonb CHECK(customer_snapshot IS NULL OR jsonb_typeof(customer_snapshot)='object'),
 ADD COLUMN checkout_snapshot jsonb CHECK(checkout_snapshot IS NULL OR jsonb_typeof(checkout_snapshot)='object'),
 ADD CONSTRAINT proposal_commercial_pair CHECK((commercial_public IS NULL)=(commercial_private IS NULL));
ALTER TABLE sales_proposal_lines
 ADD COLUMN technical_snapshot jsonb CHECK(technical_snapshot IS NULL OR jsonb_typeof(technical_snapshot)='object');

CREATE FUNCTION preserve_proposal_commercial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'draft' AND
  (NEW.commercial_public,NEW.commercial_private,NEW.customer_snapshot,NEW.checkout_snapshot)
  IS DISTINCT FROM
  (OLD.commercial_public,OLD.commercial_private,OLD.customer_snapshot,OLD.checkout_snapshot) THEN
  RAISE EXCEPTION 'Published proposal agreement is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER proposal_commercial_immutable BEFORE UPDATE ON sales_proposal_versions
 FOR EACH ROW EXECUTE FUNCTION preserve_proposal_commercial();
