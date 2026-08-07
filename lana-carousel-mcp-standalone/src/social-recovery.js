import "./social-store.js";
import { db } from "./db.js";

const timestamp = new Date().toISOString();
const result = db.prepare(`
  UPDATE social_deliveries
  SET status='FAILED',
      error='Server restarted while this delivery was in progress. Review the destination before retrying to avoid a duplicate post.',
      updated_at=?,
      completed_at=?
  WHERE status IN ('PROCESSING','UPLOADING')
`).run(timestamp, timestamp);

if (result.changes > 0) {
  console.warn(`Recovered ${result.changes} interrupted social delivery(s) as FAILED; manual retry required.`);
}
