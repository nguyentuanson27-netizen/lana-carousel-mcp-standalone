// Phần dựng DOM của khung xem trước, tách riêng để test parity nạp được đúng mã mà studio dùng.
// Mọi thay đổi ở đây phải được nhân bản sang renderSlideSnapshot trong src/service-core.js —
// xem docs/preview-render-parity.md.
export const esc = (value = "") => String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[char]);

export const FALLBACK_FONT = "TikTok Sans";
export const fontStack = family => (String(family || FALLBACK_FONT) === FALLBACK_FONT
  ? `'${FALLBACK_FONT}',sans-serif`
  : `'${esc(family)}','${FALLBACK_FONT}',sans-serif`);
export function selectedIds(slide) { return slide.selectedAssetIds?.length ? slide.selectedAssetIds : [slide.selectedAssetId].filter(Boolean); }
export function withTextBox(layer = {}) {
  return {
    boxEnabled: false, boxColor: "#FFFFFF", boxOpacity: 0.9,
    boxBorderColor: "#333333", boxBorderWidth: 0, boxBorderOpacity: 1,
    boxRadius: 24, boxPaddingX: 32, boxPaddingY: 20, boxWidth: 80, sizeRanges: [], styleRanges: [],
    ...layer
  };
}
export const MAX_ZOOM = 4;
export function imageDefaults(slide = {}) {
  return {
    cropX: slide.cropX ?? 50, cropY: slide.cropY ?? 50, cropZoom: slide.cropZoom ?? 1,
    imageBrightness: slide.imageBrightness ?? 1, imageContrast: slide.imageContrast ?? 1,
    imageSaturation: slide.imageSaturation ?? 1, imageBlur: slide.imageBlur ?? 0,
    imageGrayscale: slide.imageGrayscale ?? 0, imageHue: slide.imageHue ?? 0,
    imageFit: slide.imageFit === "contain" ? "contain" : "cover",
    imageBackground: slide.imageBackground || "#181411",
    imageFlipH: Boolean(slide.imageFlipH), imageFlipV: Boolean(slide.imageFlipV),
    frameInset: slide.frameInset ?? 40,
    frameWidth: slide.frameWidth ?? 0, frameColor: slide.frameColor || "#FFFFFF",
    frameOpacity: slide.frameOpacity ?? 1, frameRadius: slide.frameRadius ?? 0
  };
}
export function rgba(hex, opacity) {
  const value = /^#[0-9a-f]{6}$/iu.test(hex) ? hex.slice(1) : "FFFFFF";
  return `rgba(${parseInt(value.slice(0,2),16)},${parseInt(value.slice(2,4),16)},${parseInt(value.slice(4,6),16)},${opacity})`;
}
export function frameHtml(data) {
  if (!data.frameWidth) return "";
  return `<div class="image-frame" style="inset:${data.frameInset/10.8}cqw;border-width:${Math.max(0.15,data.frameWidth/10.8)}cqw;border-color:${rgba(data.frameColor,data.frameOpacity)};border-radius:${data.frameRadius/10.8}cqw"></div>`;
}
// Chuỗi filter và cấu trúc DOM ở đây phải khớp từng bước với renderSlideSnapshot trong src/service-core.js,
// nếu lệch thì ảnh tải về sẽ khác ảnh preview.
export function background(slide, data, assets) {
  const ids = selectedIds(slide), columns = ids.length <= 2 ? 1 : ids.length <= 6 ? 2 : 3;
  const filter = `brightness(${data.imageBrightness}) contrast(${data.imageContrast}) saturate(${data.imageSaturation}) grayscale(${data.imageGrayscale*100}%) hue-rotate(${data.imageHue||0}deg) blur(${data.imageBlur/10.8}cqw)`;
  // Lật quanh tâm ảnh trước, rồi mới phóng to quanh trọng tâm (cropX, cropY) — đúng thứ tự của bản render.
  const flip = `scaleX(${data.imageFlipH ? -1 : 1}) scaleY(${data.imageFlipV ? -1 : 1})`;
  const cells = ids.map(id => `<div><div class="canvas-zoom" style="transform:scale(${data.cropZoom});transform-origin:${data.cropX}% ${data.cropY}%"><img src="${esc(assets.get(id)?.publicUrl || "")}" style="object-fit:${data.imageFit === "contain" ? "contain" : "cover"};transform:${flip}"></div></div>`).join("");
  return `<div class="canvas-bg" data-canvas-bg style="grid-template-columns:repeat(${columns},1fr);background:${esc(data.imageBackground || "#181411")};filter:${filter}">${cells}</div>${frameHtml(data)}`;
}
export function normalizedStyleRanges(layer) {
  const length = String(layer.content || "").length;
  const legacy = (layer.sizeRanges || []).map(range => ({ ...range, size:range.size }));
  return [...legacy, ...(layer.styleRanges || [])].map(range => ({
    start: Math.max(0, Math.min(length, Math.round(Number(range.start) || 0))),
    end: Math.max(0, Math.min(length, Math.round(Number(range.end) || 0))),
    ...(range.size == null ? {} : { size:Math.max(24, Math.min(220, Math.round(Number(range.size) || layer.size || 72))) }),
    ...(range.font ? { font:String(range.font).slice(0,100) } : {}),
    ...(/^#[0-9a-f]{6}$/iu.test(range.color) ? { color:range.color } : {}),
    ...(range.weight ? { weight:["400","500","600","700","800","900"].includes(String(range.weight)) ? String(range.weight) : "700" } : {}),
    ...(range.underline == null ? {} : { underline:Boolean(range.underline) })
  })).filter(range => range.end > range.start);
}
export function normalizedSizeRanges(layer) {
  return normalizedStyleRanges(layer).filter(range => range.size != null);
}
export function styleAt(layer, index) {
  const style = { size:layer.size || 72, font:layer.font || "TikTok Sans", color:layer.color || "#FFFFFF", weight:String(layer.weight || "700"), underline:Boolean(layer.underline) };
  for (const range of normalizedStyleRanges(layer)) if (index >= range.start && index < range.end) Object.assign(style, {
    ...(range.size == null ? {} : { size:range.size }),
    ...(range.font ? { font:range.font } : {}),
    ...(range.color ? { color:range.color } : {}),
    ...(range.weight ? { weight:range.weight } : {}),
    ...(range.underline == null ? {} : { underline:range.underline })
  });
  return style;
}
export function richTextHtml(layer, selection = null) {
  const content = String(layer.content || "");
  if (!content) return "";
  const selected = index => Boolean(selection && selection.end > selection.start && index >= selection.start && index < selection.end);
  let html = "", start = 0, style = { ...styleAt(layer, 0), selected:selected(0) };
  const key = item => JSON.stringify(item);
  for (let index = 1; index <= content.length; index += 1) {
    const next = index < content.length ? { ...styleAt(layer, index), selected:selected(index) } : null;
    if (!next || key(next) !== key(style)) {
      const decoration = style.underline ? "text-decoration:underline;" : "";
      const highlight = style.selected ? "background:#1677ffcc;color:#fff;border-radius:.12em;" : "";
      html += `<span ${style.selected?'class="text-selection-preview"':""} style="font-size:${style.size/10.8}cqw;font-family:${fontStack(style.font)};font-weight:${style.weight};color:${style.color};${decoration}${highlight}">${esc(content.slice(start,index))}</span>`;
      start = index; style = next;
    }
  }
  return html;
}
export function layerHtml(rawLayer, index, active, selection = null, editing = false) {
  const layer = withTextBox(rawLayer);
  const boxStyle = layer.boxEnabled ? `width:${layer.boxWidth}%;padding:${layer.boxPaddingY/10.8}cqw ${layer.boxPaddingX/10.8}cqw;background:${rgba(layer.boxColor,layer.boxOpacity)};border:${layer.boxBorderWidth/10.8}cqw solid ${rgba(layer.boxBorderColor,layer.boxBorderOpacity)};border-radius:${layer.boxRadius/10.8}cqw;text-shadow:none;` : "";
  return `<div class="layer${active ? " active" : ""}${editing ? " direct-editing" : ""}" data-layer="${index}" ${editing ? 'contenteditable="true" spellcheck="false"' : ""} style="left:${layer.x}%;top:${layer.y}%;font-family:${fontStack(layer.font)};font-size:${layer.size/10.8}cqw;font-weight:${layer.weight||700};text-decoration:${layer.underline?"underline":"none"};color:${layer.color};text-align:${layer.align};opacity:${layer.opacity};rotate:${layer.rotation}deg;${boxStyle}">${richTextHtml(layer, active ? selection : null)}</div>`;
}
