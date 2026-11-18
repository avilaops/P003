-- Supply a nature for operational movements even when the calling integration only knows its account.
CREATE FUNCTION finance_ledger_nature(company uuid, family text, movement text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE category uuid; category_code text; category_name text; category_direction text;
BEGIN
  IF movement NOT IN ('credit','debit') OR family NOT IN ('manual','transfer','advance','fee') THEN
    RAISE EXCEPTION 'Tipo de movimento financeiro inválido' USING ERRCODE='23514';
  END IF;
  category_direction := CASE WHEN movement='credit' THEN 'income' ELSE 'expense' END;
  category_code := 'ERP.' || upper(family) || '.' || upper(movement);
  category_name := CASE family
    WHEN 'fee' THEN 'Tarifas de cobrança'
    WHEN 'advance' THEN 'Adiantamentos'
    WHEN 'transfer' THEN 'Transferências internas'
    ELSE 'Movimentação de conta' END || CASE WHEN movement='credit' THEN ' • entrada' ELSE ' • saída' END;
  SELECT id INTO category FROM financial_categories WHERE tenant_id=company AND code=category_code AND status='active' AND direction=category_direction;
  IF category IS NULL THEN
    INSERT INTO financial_categories(id,tenant_id,code,name,direction,status,revision)
      VALUES(gen_random_uuid(),company,category_code,category_name,category_direction,'active',1) ON CONFLICT(tenant_id,code) DO NOTHING;
    SELECT id INTO category FROM financial_categories WHERE tenant_id=company AND code=category_code AND status='active' AND direction=category_direction;
    IF category IS NULL THEN RAISE EXCEPTION 'Natureza financeira padrão indisponível' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN category;
END $$;
CREATE FUNCTION finance_classify_account_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category_id IS NULL THEN
    NEW.category_id:=finance_ledger_nature(NEW.tenant_id,CASE WHEN NEW.transfer_id IS NULL THEN 'manual' ELSE 'transfer' END,NEW.direction);
  END IF;
  IF NEW.cost_center_id IS NULL AND NEW.cost_center_distribution_id IS NULL THEN
    SELECT default_cost_center_id INTO NEW.cost_center_id FROM financial_wallet_settings WHERE tenant_id=NEW.tenant_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_classify_account_entry BEFORE INSERT ON financial_account_entries
  FOR EACH ROW EXECUTE FUNCTION finance_classify_account_entry();
