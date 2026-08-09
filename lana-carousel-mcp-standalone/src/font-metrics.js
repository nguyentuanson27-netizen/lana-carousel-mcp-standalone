import fs from "node:fs";
import path from "node:path";
import { FONT_DIRECTORY, FONT_FILES, fontStack } from "./fonts.js";

// Bộ đọc metric TrueType tối giản: chỉ lấy đúng những gì cần để tính bề rộng một dòng chữ —
// `head` (unitsPerEm), `hhea` + `hmtx` (advance width), `cmap` (mã ký tự → chỉ số glyph).
// Không xử lý kerning và ligature; trình duyệt có áp dụng nên bề rộng có thể lệch chút ít,
// nhưng sai số nhỏ hơn nhiều so với hệ số cố định trước đây.

const FALLBACK_WIDTH_RATIO = .55, FALLBACK_SPACE_RATIO = .32;

function readTableDirectory(buffer) {
  const tag = buffer.readUInt32BE(0);
  // 0x74746366 = "ttcf" (TrueType Collection): lấy font đầu tiên trong bộ.
  const offset = tag === 0x74746366 ? buffer.readUInt32BE(12) : 0;
  const tableCount = buffer.readUInt16BE(offset + 4), tables = new Map();
  for (let index = 0; index < tableCount; index += 1) {
    const record = offset + 12 + index * 16;
    tables.set(buffer.toString("ascii", record, record + 4), { offset: buffer.readUInt32BE(record + 8), length: buffer.readUInt32BE(record + 12) });
  }
  return tables;
}

function parseCmapSubtable(buffer, start) {
  const format = buffer.readUInt16BE(start), map = new Map();
  if (format === 4) {
    const segCountX2 = buffer.readUInt16BE(start + 6), segCount = segCountX2 / 2;
    const endBase = start + 14, startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2, rangeBase = deltaBase + segCountX2;
    for (let segment = 0; segment < segCount; segment += 1) {
      const end = buffer.readUInt16BE(endBase + segment * 2), first = buffer.readUInt16BE(startBase + segment * 2);
      if (first > end || first === 0xffff) continue;
      const delta = buffer.readInt16BE(deltaBase + segment * 2), rangeOffset = buffer.readUInt16BE(rangeBase + segment * 2);
      for (let code = first; code <= end; code += 1) {
        let glyph;
        if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
        else {
          const glyphIndexAddress = rangeBase + segment * 2 + rangeOffset + (code - first) * 2;
          if (glyphIndexAddress + 1 >= buffer.length) continue;
          glyph = buffer.readUInt16BE(glyphIndexAddress);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) map.set(code, glyph);
      }
    }
  } else if (format === 12) {
    const groupCount = buffer.readUInt32BE(start + 12);
    for (let group = 0; group < groupCount; group += 1) {
      const record = start + 16 + group * 12;
      const first = buffer.readUInt32BE(record), end = buffer.readUInt32BE(record + 4), glyph = buffer.readUInt32BE(record + 8);
      // Chặn nhóm quá lớn để không phình bộ nhớ với font phủ toàn bộ Unicode.
      for (let code = first; code <= end && code - first < 0x10000; code += 1) map.set(code, glyph + (code - first));
    }
  }
  return map;
}

function parseCmap(buffer, table) {
  const base = table.offset, tableCount = buffer.readUInt16BE(base + 2);
  let best = null, bestScore = -1;
  for (let index = 0; index < tableCount; index += 1) {
    const record = base + 4 + index * 8;
    const platform = buffer.readUInt16BE(record), encoding = buffer.readUInt16BE(record + 2);
    const offset = buffer.readUInt32BE(record + 4);
    // Ưu tiên Unicode full (format 12) rồi tới Windows BMP.
    const score = platform === 3 && encoding === 10 ? 3 : platform === 0 ? 2 : platform === 3 && encoding === 1 ? 1 : 0;
    if (score > bestScore) { bestScore = score; best = base + offset; }
  }
  return best === null ? new Map() : parseCmapSubtable(buffer, best);
}

// `hmtx` chỉ mô tả instance mặc định của font biến thiên (thường là độ đậm 400). Studio render ở
// 700–900 nên phải cộng thêm delta từ `HVAR`, nếu không bề rộng thiếu tới ~10% so với trình duyệt.
function parseWeightAxis(buffer, fvar) {
  if (!fvar) return null;
  const axesOffset = fvar.offset + buffer.readUInt16BE(fvar.offset + 4);
  const axisCount = buffer.readUInt16BE(fvar.offset + 8), axisSize = buffer.readUInt16BE(fvar.offset + 10);
  const axes = [];
  for (let index = 0; index < axisCount; index += 1) {
    const record = axesOffset + index * axisSize;
    axes.push({
      tag: buffer.toString("ascii", record, record + 4),
      min: buffer.readInt32BE(record + 4) / 65536,
      default: buffer.readInt32BE(record + 8) / 65536,
      max: buffer.readInt32BE(record + 12) / 65536
    });
  }
  return axes.length ? axes : null;
}

function parseVariationRegions(buffer, start) {
  const axisCount = buffer.readUInt16BE(start), regionCount = buffer.readUInt16BE(start + 2), regions = [];
  for (let region = 0; region < regionCount; region += 1) {
    const axes = [];
    for (let axis = 0; axis < axisCount; axis += 1) {
      const record = start + 4 + (region * axisCount + axis) * 6;
      axes.push({
        start: buffer.readInt16BE(record) / 16384,
        peak: buffer.readInt16BE(record + 2) / 16384,
        end: buffer.readInt16BE(record + 4) / 16384
      });
    }
    regions.push(axes);
  }
  return regions;
}

function parseItemVariationData(buffer, start) {
  const itemCount = buffer.readUInt16BE(start), packed = buffer.readUInt16BE(start + 2);
  const longWords = Boolean(packed & 0x8000), wordCount = packed & 0x7fff;
  const regionCount = buffer.readUInt16BE(start + 4);
  const regionIndexes = [];
  for (let index = 0; index < regionCount; index += 1) regionIndexes.push(buffer.readUInt16BE(start + 6 + index * 2));
  const rowStart = start + 6 + regionCount * 2;
  const rowLength = longWords ? wordCount * 4 + (regionCount - wordCount) * 2 : wordCount * 2 + (regionCount - wordCount);
  return { itemCount, longWords, wordCount, regionIndexes, rowStart, rowLength };
}

function readDelta(buffer, data, item, column) {
  const row = data.rowStart + item * data.rowLength;
  if (column < data.wordCount) {
    const at = row + column * (data.longWords ? 4 : 2);
    return data.longWords ? buffer.readInt32BE(at) : buffer.readInt16BE(at);
  }
  const at = row + data.wordCount * (data.longWords ? 4 : 2) + (column - data.wordCount) * (data.longWords ? 2 : 1);
  return data.longWords ? buffer.readInt16BE(at) : buffer.readInt8(at);
}

function parseDeltaSetIndexMap(buffer, start) {
  const format = buffer.readUInt8(start), entryFormat = buffer.readUInt8(start + 1);
  const mapCount = format === 0 ? buffer.readUInt16BE(start + 2) : buffer.readUInt32BE(start + 2);
  const dataStart = start + (format === 0 ? 4 : 6);
  const innerBits = (entryFormat & 0x0f) + 1, entrySize = ((entryFormat & 0x30) >> 4) + 1;
  return { mapCount, dataStart, innerBits, entrySize };
}

function parseHvar(buffer, hvar) {
  if (!hvar) return null;
  const storeOffset = buffer.readUInt32BE(hvar.offset + 4);
  if (!storeOffset) return null;
  const store = hvar.offset + storeOffset;
  const regions = parseVariationRegions(buffer, store + buffer.readUInt32BE(store + 2));
  const dataCount = buffer.readUInt16BE(store + 6), dataSets = [];
  for (let index = 0; index < dataCount; index += 1) dataSets.push(parseItemVariationData(buffer, store + buffer.readUInt32BE(store + 8 + index * 4)));
  const mappingOffset = buffer.readUInt32BE(hvar.offset + 8);
  return { regions, dataSets, advanceMap: mappingOffset ? parseDeltaSetIndexMap(buffer, hvar.offset + mappingOffset) : null };
}

function parseFont(filePath) {
  const buffer = fs.readFileSync(filePath), tables = readTableDirectory(buffer);
  const head = tables.get("head"), hhea = tables.get("hhea"), hmtx = tables.get("hmtx"), cmap = tables.get("cmap");
  if (!head || !hhea || !hmtx || !cmap) return null;
  const unitsPerEm = buffer.readUInt16BE(head.offset + 18);
  const metricCount = buffer.readUInt16BE(hhea.offset + 34);
  if (!unitsPerEm || !metricCount) return null;
  const advances = new Uint16Array(metricCount);
  for (let index = 0; index < metricCount; index += 1) advances[index] = buffer.readUInt16BE(hmtx.offset + index * 4);
  let axes = null, hvar = null;
  try {
    axes = parseWeightAxis(buffer, tables.get("fvar"));
    hvar = axes ? parseHvar(buffer, tables.get("HVAR")) : null;
  } catch { axes = null; hvar = null; }
  return { buffer, unitsPerEm, advances, glyphs: parseCmap(buffer, cmap), axes, hvar };
}

/** Toạ độ chuẩn hoá [-1,1] của một trục theo giá trị người dùng chọn. */
function normalizeAxis(axis, value) {
  if (value === axis.default) return 0;
  if (value < axis.default) return axis.default === axis.min ? 0 : Math.max(-1, (value - axis.default) / (axis.default - axis.min));
  return axis.max === axis.default ? 0 : Math.min(1, (value - axis.default) / (axis.max - axis.default));
}

function regionScalar(region, coordinates) {
  let scalar = 1;
  for (let index = 0; index < region.length; index += 1) {
    const { start, peak, end } = region[index];
    if (peak === 0) continue;
    const coordinate = coordinates[index] ?? 0;
    if (coordinate === peak) continue;
    if (coordinate <= start || coordinate >= end) return 0;
    scalar *= coordinate < peak ? (coordinate - start) / (peak - start) : (end - coordinate) / (end - peak);
  }
  return scalar;
}

function advanceDelta(metrics, glyph, weight, size) {
  const { hvar, axes } = metrics;
  if (!hvar || !axes) return 0;
  // CSS mặc định `font-optical-sizing: auto`, tức trình duyệt gán trục `opsz` bằng cỡ chữ tính theo pt.
  // Bỏ qua trục này thì font có opsz (TikTok Sans) lệch bề rộng vài phần trăm.
  const opticalSize = size * .75;
  const coordinates = axes.map(axis =>
    axis.tag === "wght" ? normalizeAxis(axis, weight)
      : axis.tag === "opsz" ? normalizeAxis(axis, opticalSize)
        : 0);
  if (coordinates.every(value => value === 0)) return 0;
  let outer = 0, inner = glyph;
  if (hvar.advanceMap) {
    const map = hvar.advanceMap, index = Math.min(glyph, map.mapCount - 1);
    let entry = 0;
    for (let byte = 0; byte < map.entrySize; byte += 1) entry = (entry << 8) | metrics.buffer.readUInt8(map.dataStart + index * map.entrySize + byte);
    outer = entry >> map.innerBits;
    inner = entry & ((1 << map.innerBits) - 1);
  }
  const data = hvar.dataSets[outer];
  if (!data || inner >= data.itemCount) return 0;
  let delta = 0;
  for (let column = 0; column < data.regionIndexes.length; column += 1) {
    const scalar = regionScalar(hvar.regions[data.regionIndexes[column]] || [], coordinates);
    if (scalar !== 0) delta += scalar * readDelta(metrics.buffer, data, inner, column);
  }
  return delta;
}

const cache = new Map();

// Tên file tĩnh của Google Fonts mang sẵn tên độ đậm; dùng để chọn đúng file cho họ nhiều file.
const STATIC_WEIGHTS = [["Thin", 100], ["ExtraLight", 200], ["Light", 300], ["Regular", 400], ["Medium", 500],
  ["SemiBold", 600], ["ExtraBold", 800], ["Black", 900], ["Bold", 700]];

function weightOfFile(name) {
  const match = STATIC_WEIGHTS.find(([label]) => name.includes(`-${label}`));
  return match ? match[1] : 400;
}

/** Chọn file gần nhất với độ đậm cần dùng; font biến thiên chỉ có một file và tự nội suy qua HVAR. */
function fontFileFor(family, weight) {
  const files = FONT_FILES[family] || (family === "Courier New" ? FONT_FILES["Courier Prime"] : null);
  if (!files?.length) return null;
  const best = files.reduce((chosen, file) =>
    Math.abs(weightOfFile(file) - weight) < Math.abs(weightOfFile(chosen) - weight) ? file : chosen);
  return path.join(FONT_DIRECTORY, best);
}

function metricsFor(family, weight = 400) {
  const filePath = fontFileFor(String(family || ""), weight);
  if (!filePath) return null;
  if (cache.has(filePath)) return cache.get(filePath);
  let metrics = null;
  if (fs.existsSync(filePath)) {
    try { metrics = parseFont(filePath); } catch { metrics = null; }
  }
  cache.set(filePath, metrics);
  return metrics;
}

function advanceIn(family, codePoint, weight, size) {
  const metrics = metricsFor(family, weight);
  if (!metrics) return null;
  const glyph = metrics.glyphs.get(codePoint);
  if (glyph === undefined) return null;
  const base = metrics.advances[Math.min(glyph, metrics.advances.length - 1)];
  if (!base) return null;
  return (base + advanceDelta(metrics, glyph, weight, size)) / metrics.unitsPerEm;
}

const normalizeWeight = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(1000, parsed)) : 400;
};

/**
 * Bề rộng của một ký tự ở cỡ chữ và độ đậm cho trước, tính bằng pixel.
 * Đi theo đúng chuỗi font dự phòng mà trình duyệt dùng, nên ký tự tiếng Việt trong các font
 * thiếu glyph được đo bằng chính font sẽ vẽ chúng.
 * Quay về ước lượng cũ khi không đọc được font nào trong chuỗi.
 */
export function characterWidth(character, size, family, weight = 400) {
  const codePoint = character.codePointAt(0), resolvedWeight = normalizeWeight(weight);
  for (const candidate of fontStack(family)) {
    const ratio = advanceIn(candidate, codePoint, resolvedWeight, size);
    if (ratio !== null) return ratio * size;
  }
  return size * (/\s/u.test(character) ? FALLBACK_SPACE_RATIO : FALLBACK_WIDTH_RATIO);
}

/** Các ký tự trong `sample` mà font không có glyph — dùng cho test phủ tiếng Việt. */
export function missingGlyphs(family, sample) {
  const metrics = metricsFor(family, 400);
  if (!metrics) return [...sample];
  return [...sample].filter(character => !/\s/u.test(character) && !metrics.glyphs.has(character.codePointAt(0)));
}

export function hasMetrics(family) {
  return metricsFor(family, 400) !== null;
}
