import { db } from "./db.js";

db.exec(`
  DROP TRIGGER IF EXISTS trg_candidate_limit;
  CREATE TRIGGER trg_candidate_limit
  BEFORE INSERT ON slide_asset_candidates
  WHEN NOT EXISTS (
    SELECT 1 FROM slide_asset_candidates
    WHERE slide_id=NEW.slide_id AND asset_id=NEW.asset_id
  ) AND (
    SELECT COUNT(*) FROM slide_asset_candidates WHERE slide_id=NEW.slide_id
  ) >= 10
  BEGIN
    SELECT RAISE(ABORT, 'CANDIDATE_LIMIT_REACHED');
  END;
`);

export function isCandidateLimitError(error) {
  return /CANDIDATE_LIMIT_REACHED/u.test(String(error?.message || error || ""));
}
