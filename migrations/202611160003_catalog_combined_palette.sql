ALTER TABLE products DROP CONSTRAINT products_finishing_palette_check;
ALTER TABLE products ADD CONSTRAINT products_finishing_palette_check
    CHECK(finishing_palette IN ('','dhz-hammerforce-pro','dhz-sforce','dhz-combined'));
