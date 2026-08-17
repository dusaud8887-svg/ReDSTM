ALTER TABLE commands ADD COLUMN collection_mode TEXT
  CHECK (collection_mode IS NULL OR collection_mode = 'fill-missing-content');
