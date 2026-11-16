-- Preserve the exact compatibility state of every existing publication. Never
-- infer a revision from a price snapshot: already stale products stay stale.
ALTER TABLE products ADD COLUMN price_revision bigint;
UPDATE products SET price_revision=revision;
ALTER TABLE products ALTER COLUMN price_revision SET NOT NULL;
ALTER TABLE products ADD CONSTRAINT products_price_revision_positive CHECK(price_revision>0);

CREATE FUNCTION preserve_product_price_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        -- Ignore any supplied compatibility revision, including a manual reset.
        NEW.price_revision:=NEW.revision;
    ELSIF (to_jsonb(NEW)-ARRAY['price_revision','revision','updated_at',
        'structure_colors','swing_arm_colors','upholstery_colors','finishing_palette',
        'plate_holder_colors','plate_holder_types','plate_holder_type'])
        IS NOT DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['price_revision','revision','updated_at',
        'structure_colors','swing_arm_colors','upholstery_colors','finishing_palette',
        'plate_holder_colors','plate_holder_types','plate_holder_type']) THEN
        NEW.price_revision:=OLD.price_revision;
    ELSE
        -- Monotonic even if a direct writer does not advance the general ETag.
        NEW.price_revision:=GREATEST(OLD.price_revision+1,NEW.revision);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER products_price_revision_guard BEFORE INSERT OR UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION preserve_product_price_revision();
