-- Rebuild the immutable v1 FTS definition with the fields used by current search.
DROP TRIGGER IF EXISTS master_drugs_ai;
DROP TRIGGER IF EXISTS master_drugs_ad;
DROP TRIGGER IF EXISTS master_drugs_au;
DROP TABLE IF EXISTS master_drugs_fts;

CREATE VIRTUAL TABLE master_drugs_fts USING fts5(
  id UNINDEXED,
  trade_name,
  trade_name_en,
  generic_name,
  active_ingredient,
  manufacturer,
  category,
  content='master_drugs',
  content_rowid='id'
);

CREATE TRIGGER master_drugs_ai AFTER INSERT ON master_drugs BEGIN
  INSERT INTO master_drugs_fts(rowid, id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
  VALUES (new.id, new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient, new.manufacturer, new.category);
END;

CREATE TRIGGER master_drugs_ad AFTER DELETE ON master_drugs BEGIN
  INSERT INTO master_drugs_fts(master_drugs_fts, rowid, id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
  VALUES ('delete', old.id, old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient, old.manufacturer, old.category);
END;

CREATE TRIGGER master_drugs_au AFTER UPDATE ON master_drugs BEGIN
  INSERT INTO master_drugs_fts(master_drugs_fts, rowid, id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
  VALUES ('delete', old.id, old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient, old.manufacturer, old.category);
  INSERT INTO master_drugs_fts(rowid, id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
  VALUES (new.id, new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient, new.manufacturer, new.category);
END;

INSERT INTO master_drugs_fts(rowid, id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category)
SELECT id, id, trade_name, trade_name_en, generic_name, active_ingredient, manufacturer, category
FROM master_drugs;
