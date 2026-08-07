import { config } from "./config.js";
import { db, sql } from "./db.js";
import { AppError } from "./errors.js";

const now = () => new Date().toISOString();

export function consumeApiQuota(clientId, { mutations = 0, heavy = 0 } = {}) {
  const mutationWeight = Math.max(0, Math.trunc(Number(mutations) || 0));
  const heavyWeight = Math.max(0, Math.trunc(Number(heavy) || 0));
  if (!mutationWeight && !heavyWeight) return { allowed: true, mutations: 0, heavy: 0 };

  const id = String(clientId || "anonymous");
  const day = now().slice(0, 10);
  return db.transaction(() => {
    const current = sql.getApiUsage.get(id, day) || { mutations: 0, heavy: 0 };
    const nextMutations = Number(current.mutations || 0) + mutationWeight;
    const nextHeavy = Number(current.heavy || 0) + heavyWeight;

    if (nextMutations > config.apiDailyMutationQuota) {
      throw new AppError("DAILY_QUOTA_EXCEEDED", "Đã vượt quota thao tác trong ngày.", 429);
    }
    if (nextHeavy > config.apiDailyHeavyQuota) {
      throw new AppError("HEAVY_QUOTA_EXCEEDED", "Đã vượt quota import/render trong ngày.", 429);
    }

    sql.upsertApiUsage.run({
      client_id: id,
      day,
      mutations: nextMutations,
      heavy: nextHeavy,
      updated_at: now()
    });
    return { allowed: true, mutations: nextMutations, heavy: nextHeavy };
  })();
}

export function getApiQuotaUsage(clientId, day = now().slice(0, 10)) {
  return sql.getApiUsage.get(String(clientId || "anonymous"), day) || { mutations: 0, heavy: 0 };
}
