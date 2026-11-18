-- NULL identifies rows imported before bank document references were recorded.
ALTER TABLE finance_bank_lines ADD COLUMN document_references text[];
