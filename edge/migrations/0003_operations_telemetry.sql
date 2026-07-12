ALTER TABLE board_status ADD COLUMN board_name TEXT;
ALTER TABLE board_status ADD COLUMN group_name TEXT;
ALTER TABLE board_status ADD COLUMN running INTEGER NOT NULL DEFAULT 0 CHECK (running >= 0);
ALTER TABLE board_status ADD COLUMN done INTEGER NOT NULL DEFAULT 0 CHECK (done >= 0);
ALTER TABLE board_status ADD COLUMN inventory_next_page INTEGER
  CHECK (inventory_next_page IS NULL OR inventory_next_page >= 1);
ALTER TABLE board_status ADD COLUMN last_inventory_at TEXT;
ALTER TABLE board_status ADD COLUMN inventory_pass_started_at TEXT;
