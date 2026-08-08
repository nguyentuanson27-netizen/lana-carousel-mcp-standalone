import { db } from "./db.js";
import { recomputeSocialPostStatus } from "./social-store.js";

export function recoverInterruptedSocialDeliveries() {
  const interruptedPostIds = db.prepare(`
    SELECT DISTINCT post_id
    FROM social_deliveries
    WHERE status IN ('PROCESSING','UPLOADING')
  `).all().map(row => row.post_id).filter(Boolean);

  if (!interruptedPostIds.length) return 0;

  const timestamp = new Date().toISOString();
  const recover = db.prepare(`
    UPDATE social_deliveries
    SET status='FAILED',
        error='Server restarted while this delivery was in progress. Review the destination before retrying to avoid a duplicate post.',
        updated_at=?,
        completed_at=?
    WHERE status IN ('PROCESSING','UPLOADING')
  `);

  const recovered = db.transaction(() => {
    const result = recover.run(timestamp, timestamp);
    for (const postId of interruptedPostIds) recomputeSocialPostStatus(postId);
    return result.changes;
  })();

  if (recovered > 0) {
    console.warn(`Recovered ${recovered} interrupted social delivery(s) as FAILED; manual retry required.`);
  }
  return recovered;
}

recoverInterruptedSocialDeliveries();
