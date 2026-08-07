import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { importAndStoreImage } from "./image-importer.js";
import * as core from "./service-core.js";
import {
  deleteProjectAudioFiles,
  listProjectAudioAssets,
  prepareProjectAudioClone,
  withoutProjectAudioSync
} from "./project-audio.js";

export * from "./service-core.js";

function isAssetHashConflict(error) {
  return /UNIQUE constraint failed:\s*assets\.project_id,\s*assets\.sha256/iu.test(String(error?.message || error || ""));
}

async function duplicateRetryStored(stored) {
  const storageKey = `.duplicate-retry-${randomUUID()}.tmp`;
  const absolutePath = path.join(config.assetDirectory, storageKey);
  await fs.writeFile(absolutePath, "duplicate-retry", { flag: "wx" });
  return {
    ...stored,
    storageKey,
    absolutePath,
    publicUrl: `${config.publicBaseUrl.replace(/\/$/u, "")}/assets/${encodeURIComponent(storageKey)}`
  };
}

export async function importAssetFromUrl(input) {
  const importer = typeof input.importer === "function" ? input.importer : importAndStoreImage;
  let stored;
  try {
    return await core.importAssetFromUrl({
      ...input,
      importer: async args => {
        stored = await importer(args);
        return stored;
      }
    });
  } catch (error) {
    if (!isAssetHashConflict(error) || !stored?.sha256) throw error;
    const existing = sql.findAssetByHash.get(input.projectId, stored.sha256);
    if (!existing) throw error;
    const currentSlide = sql.getSlide.get(input.slideId);
    if (
      input.selectAsset !== false &&
      currentSlide?.selected_asset_id &&
      currentSlide.selected_asset_id !== existing.id &&
      !input.forceReplace
    ) throw error;
    const retryStored = await duplicateRetryStored(stored);
    return core.importAssetFromUrl({
      ...input,
      forceReplace: input.forceReplace || currentSlide?.selected_asset_id === existing.id,
      importer: async () => retryStored
    });
  }
}

export async function deleteProject(projectId) {
  const audioRows = listProjectAudioAssets(projectId);
  const result = await core.deleteProject(projectId);
  const deletedAudio = await deleteProjectAudioFiles(audioRows);
  return { ...result, deletedAudio };
}

export async function cloneProject(projectId) {
  const source = core.getProject(projectId);
  let clone;
  let preparedAudio;
  try {
    clone = await withoutProjectAudioSync(() => core.cloneProject(projectId));
    preparedAudio = await prepareProjectAudioClone(source.videoSettings?.audioUrl || "", clone.id);
    if (preparedAudio) {
      clone = core.updateProjectVideo({
        projectId: clone.id,
        enabled: clone.videoEnabled,
        settings: { audioUrl: preparedAudio.url }
      });
      db.prepare(`
        UPDATE project_versions
        SET snapshot=replace(snapshot, ?, ?)
        WHERE project_id=?
      `).run(String(source.videoSettings.audioUrl), preparedAudio.url, clone.id);
    }
    return clone;
  } catch (error) {
    if (preparedAudio?.absolutePath) await fs.unlink(preparedAudio.absolutePath).catch(() => undefined);
    if (clone?.id) await deleteProject(clone.id).catch(() => undefined);
    throw error;
  }
}

export async function purgeExpiredProjects() {
  const removed = [];
  for (const project of sql.getExpiredProjects.all()) {
    const result = await deleteProject(project.id);
    removed.push({
      id: project.id,
      title: project.title,
      assets: result.deletedAssets,
      audio: result.deletedAudio
    });
  }
  return removed;
}
