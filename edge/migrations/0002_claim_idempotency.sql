ALTER TABLE commands ADD COLUMN claim_idempotency_key TEXT;
CREATE UNIQUE INDEX commands_claim_idempotency_idx
  ON commands(claim_idempotency_key)
  WHERE claim_idempotency_key IS NOT NULL;
