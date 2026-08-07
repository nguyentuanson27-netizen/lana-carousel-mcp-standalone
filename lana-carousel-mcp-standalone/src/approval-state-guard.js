import { db, sql } from "./db.js";

// Keep approval changes coupled to the immediately preceding database mutation.
// `importAssetFromUrl()` calls addCandidate/assignAsset immediately before these
// statements, so a duplicate candidate (changes() === 0) remains a true no-op.
sql.markImagesPending = db.prepare(`
  UPDATE projects
  SET image_status='PENDING',updated_at=?
  WHERE id=? AND changes()>0
`);

sql.markSlideImagePending = db.prepare(`
  UPDATE slides
  SET image_approved=0
  WHERE id=? AND changes()>0
`);
