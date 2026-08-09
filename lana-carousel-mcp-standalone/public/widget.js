import { esc, fontStack, FALLBACK_FONT, MAX_ZOOM, selectedIds, withTextBox, imageDefaults, rgba,
  frameHtml, background, cropFor, normalizedStyleRanges, normalizedSizeRanges, styleAt, richTextHtml, layerHtml }
  from "/preview-dom.js";
const params = new URLSearchParams(location.search);
const projectId = params.get("projectId");
const $ = id => document.getElementById(id);
const fonts = ["TikTok Sans", "Montserrat", "Poppins", "Bebas Neue", "Roboto", "Playfair Display", "Courier New"];
// Bebas Neue, Poppins và Courier New thiếu glyph tiếng Việt dựng sẵn. Khai báo sẵn font dự phòng
// để trình duyệt và bản render lấy glyph từ cùng một file — phải trùng FALLBACK_FAMILY trong src/fonts.js.
let project, assets, view = "content", renderTimer;
const picks = new Map(), drafts = new Map(), selectedLayers = new Map(), activeCells = new Map(), histories = new Map(), redos = new Map(), sectionStates = new Map(), textSelections = new Map(), directEditing = new Set(), designDirty = new Set();

function candidateAssets(slide) { return [...new Set([...(slide.candidateAssetIds || []), slide.selectedAssetId].filter(Boolean))].map(id => assets.get(id)).filter(Boolean); }
function defaultLayer(slide) { return withTextBox({ id: crypto.randomUUID(), role: "headline", content: slide.headline || slide.overlayText, enabled: slide.textEnabled, font: slide.textFont || "TikTok Sans", size: slide.textSize || 72, x: slide.textX || 50, y: slide.textY || 42, color: slide.textColor || "#FFFFFF", align: slide.textAlign || "center", opacity: 1, rotation: 0 }); }
function defaultBodyLayer(slide) { return withTextBox({ id: crypto.randomUUID(), role: "body", content: slide.body || "", enabled: Boolean(slide.body), font: slide.textFont || "TikTok Sans", size: 42, x: 50, y: 66, color: slide.textColor || "#FFFFFF", align: "center", opacity: 0.95, rotation: 0 }); }
function initialLayers(slide) { return [defaultLayer(slide), defaultBodyLayer(slide)]; }
function draft(slide) {
  if (!drafts.has(slide.id)) drafts.set(slide.id, { ...imageDefaults(slide), layers: slide.textLayers?.length ? structuredClone(slide.textLayers).map(withTextBox) : initialLayers(slide) });
  return drafts.get(slide.id);
}
function syncContentLayers(slide, headline, body) {
  const data = draft(slide), layers = structuredClone(data.layers || []).map(withTextBox);
  let headlineLayer = layers.find(layer => layer.role === "headline");
  if (!headlineLayer) {
    headlineLayer = layers[0] || defaultLayer(slide);
    headlineLayer.role = "headline";
    if (!layers.length) layers.push(headlineLayer);
  }
  headlineLayer.sizeRanges = remapSizeRanges(String(headlineLayer.content || ""), headline, headlineLayer.sizeRanges || []);
  headlineLayer.styleRanges = remapSizeRanges(String(headlineLayer.content || ""), headline, headlineLayer.styleRanges || []);
  headlineLayer.content = headline;
  headlineLayer.enabled = true;

  let bodyLayer = layers.find(layer => layer.role === "body");
  if (!bodyLayer) {
    bodyLayer = defaultBodyLayer(slide);
    const headlineIndex = layers.indexOf(headlineLayer);
    layers.splice(headlineIndex + 1, 0, bodyLayer);
  }
  bodyLayer.sizeRanges = remapSizeRanges(String(bodyLayer.content || ""), body, bodyLayer.sizeRanges || []);
  bodyLayer.styleRanges = remapSizeRanges(String(bodyLayer.content || ""), body, bodyLayer.styleRanges || []);
  bodyLayer.content = body;
  bodyLayer.enabled = Boolean(body.trim());
  data.layers = layers;
  return layers;
}
// Ô lưới đang được chỉnh. Thanh trượt crop và thao tác kéo tác động lên ô này;
// slide chỉ có một ảnh thì luôn là ảnh đó.
function activeCell(slide) {
  const ids = selectedIds(slide);
  const chosen = activeCells.get(slide.id);
  return ids.includes(chosen) ? chosen : ids[0] || null;
}
/** Đọc crop hiệu lực của ô đang chỉnh để đổ vào thanh trượt. */
function activeCrop(slide, data) { return cropFor(data, activeCell(slide)); }
/** Ghi một giá trị crop: slide nhiều ảnh thì ghi riêng cho ô, một ảnh thì ghi thẳng cấp slide. */
function setCrop(slide, data, patch) {
  const ids = selectedIds(slide);
  if (ids.length <= 1) { Object.assign(data, patch); return; }
  const id = activeCell(slide);
  if (!id) return;
  data.assetCrops = { ...data.assetCrops, [id]: { ...cropFor(data, id), ...patch } };
}

function markDesignDirty(slideId) {
  designDirty.add(slideId);
  const editor = document.querySelector(`[data-editor="${slideId}"]`);
  if (editor) editor.dataset.designSaved = "false";
}
function remember(slideId, markDirty = true) {
  const history = histories.get(slideId) || [];
  history.push(JSON.stringify(drafts.get(slideId)));
  if (history.length > 30) history.shift();
  histories.set(slideId, history);
  redos.set(slideId, []);
  if (markDirty) markDesignDirty(slideId);
}

function contentCard(slide) { return `<article class="card" data-content="${slide.id}"><div class="number">Slide ${slide.position}</div><div class="fields"><label class="field wide">Tiêu đề<input data-f="headline" value="${esc(slide.headline)}"></label><label class="field wide">Nội dung<textarea data-f="body">${esc(slide.body)}</textarea></label></div><button class="action save-content" data-slide="${slide.id}">Lưu nội dung</button></article>`; }
function imageCard(slide) {
  const approved = new Set(selectedIds(slide)), chosen = picks.get(slide.id) || new Set();
  const cards = candidateAssets(slide).map(asset => `<article class="candidate${approved.has(asset.id) && slide.imageApproved ? " selected" : ""}"><img src="${esc(asset.publicUrl)}"><div class="candidate-actions"><button data-one="${asset.id}" data-slide="${slide.id}">${approved.size === 1 && approved.has(asset.id) && slide.imageApproved ? "Đã duyệt ✓" : "Duyệt ảnh này"}</button><label class="pick"><input type="checkbox" data-pick="${asset.id}" data-slide="${slide.id}" ${chosen.has(asset.id) ? "checked" : ""}> Chọn ghép lưới</label></div></article>`).join("");
  return `<article class="card"><div class="card-head"><div><div class="number">Slide ${slide.position}</div><h2>${esc(slide.headline)}</h2></div><span class="status${slide.imageApproved ? " done" : ""}">${slide.imageApproved ? "Đã duyệt" : "Chờ duyệt"}</span></div><div class="candidate-grid">${cards}</div><div class="bar"><small class="muted">${candidateAssets(slide).length}/10 ảnh · Chọn lưới: ${chosen.size}</small><button class="action approve-grid" data-slide="${slide.id}" ${chosen.size < 2 ? "disabled" : ""}>Duyệt ghép lưới (${chosen.size})</button></div></article>`;
}
function remapSizeRanges(oldContent, newContent, ranges = []) {
  if (oldContent === newContent) return ranges;
  let prefix = 0;
  while (prefix < oldContent.length && prefix < newContent.length && oldContent[prefix] === newContent[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldContent.length-prefix && suffix < newContent.length-prefix && oldContent[oldContent.length-1-suffix] === newContent[newContent.length-1-suffix]) suffix += 1;
  const oldTail = oldContent.length - suffix, delta = newContent.length - oldContent.length;
  return ranges.flatMap(range => {
    if (range.end <= prefix) return [range];
    if (range.start >= oldTail) return [{ ...range, start:range.start+delta, end:range.end+delta }];
    return [];
  });
}
function directToolbarHtml(layer, slideId, index) {
  const editing = directEditing.has(`${slideId}:${index}`);
  return `<div class="direct-toolbar" data-direct-toolbar="${slideId}"><span class="direct-hint">${editing ? "Đang sửa trực tiếp · chọn chữ để định dạng" : "Nhấp đúp hộp chữ để sửa trực tiếp"}</span><select data-direct-style="font" title="Font">${fonts.map(font=>`<option ${font===layer.font?"selected":""}>${font}</option>`).join("")}</select><input type="number" min="24" max="220" value="${layer.size}" data-direct-style="size" title="Cỡ chữ"><button type="button" class="tool direct-bold ${String(layer.weight||"700")!=="400"?"active":""}" title="Đậm"><strong>B</strong></button><button type="button" class="tool direct-underline ${layer.underline?"active":""}" title="Gạch chân"><u>U</u></button><input type="color" value="${layer.color}" data-direct-style="color" title="Màu chữ"><button type="button" class="tool direct-box ${layer.boxEnabled?"active":""}">Hộp chữ</button><input type="color" value="${layer.boxColor}" data-direct-style="boxColor" title="Màu hộp">${editing?'<button type="button" class="tool direct-finish">Xong</button>':'<button type="button" class="action direct-start">Sửa chữ trực tiếp</button>'}</div>`;
}
function startDirectEditing(slideId, index) {
  selectedLayers.set(slideId,index);
  directEditing.add(`${slideId}:${index}`);
  render();
  requestAnimationFrame(() => document.querySelector(`[data-editor="${slideId}"] [data-layer="${index}"]`)?.focus());
}
function directSelection(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0), before = range.cloneRange();
  before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end:start + range.toString().length };
}
function applyDirectStyle(slideId, index, patch) {
  const data = drafts.get(slideId), layer = data?.layers[index];
  if (!layer) return;
  remember(slideId);
  const selection = textSelections.get(`${slideId}:${index}`);
  if (selection?.end > selection?.start && directEditing.has(`${slideId}:${index}`)) {
    layer.styleRanges = [...(layer.styleRanges||[]), { start:selection.start, end:selection.end, ...patch }];
  } else Object.assign(layer, patch);
  render();
}
function sectionIsOpen(slideId, section) { return sectionStates.get(`${slideId}:${section}`) === true; }
function textStyleControlsHtml(layer, slideId) {
  const open = sectionIsOpen(slideId, "textStyle"), styledCount = normalizedStyleRanges(layer).length;
  return `<details class="editor-section text-style-controls" data-editor-section="textStyle" data-slide="${slideId}" ${open?"open":""}><summary><strong>Kiểu chữ</strong><span class="section-meta">${esc(layer.font)} · ${layer.size}px${styledCount?` · ${styledCount} đoạn riêng`:""}</span></summary><div class="section-body"><div class="fields"><label class="field">Font<select data-control="font">${fonts.map(font=>`<option ${font===layer.font?"selected":""}>${font}</option>`).join("")}</select></label><label class="field">Màu<input type="color" data-control="color" value="${layer.color}"></label><label class="field">Cỡ mặc định <span class="range-value">${layer.size}</span><input type="range" min="24" max="220" data-control="size" value="${layer.size}"></label><label class="field">Xoay <span class="range-value">${layer.rotation}°</span><input type="range" min="-180" max="180" data-control="rotation" value="${layer.rotation}"></label><label class="field">Độ trong <span class="range-value">${Math.round(layer.opacity*100)}%</span><input type="range" min="10" max="100" data-control="opacity" value="${layer.opacity*100}"></label><label class="field">Căn<select data-control="align"><option value="left" ${layer.align==="left"?"selected":""}>Trái</option><option value="center" ${layer.align==="center"?"selected":""}>Giữa</option><option value="right" ${layer.align==="right"?"selected":""}>Phải</option></select></label><div class="field wide selection-size-tools"><span>Bôi đen một đoạn trong ô Nội dung, chọn định dạng rồi áp dụng.</span><div class="selection-format-grid"><label>Font<select data-selection-font><option value="">Giữ nguyên</option>${fonts.map(font=>`<option>${font}</option>`).join("")}</select></label><label>Cỡ<input type="number" min="24" max="220" placeholder="Giữ nguyên" data-selection-size></label><label>Độ đậm<select data-selection-weight><option value="">Giữ nguyên</option><option value="400">Thường</option><option value="500">Vừa</option><option value="600">Hơi đậm</option><option value="700">Đậm</option><option value="800">Rất đậm</option><option value="900">Đen</option></select></label><label class="toggle"><input type="checkbox" data-selection-underline> Gạch chân</label></div><div class="selection-size-row"><button type="button" class="tool apply-selected-style">Áp dụng cho đoạn chọn</button><button type="button" class="tool clear-selected-styles" ${styledCount?"":"disabled"}>Xóa định dạng riêng</button></div></div></div></div></details>`;
}

function textBoxControlsHtml(rawLayer, slideId) {
  const layer = withTextBox(rawLayer), percent = value => Math.round(value * 100), open = sectionIsOpen(slideId, "textBox");
  return `<details class="editor-section text-box-controls" data-editor-section="textBox" data-slide="${slideId}" ${open?"open":""}><summary><strong>Hộp chữ</strong><span class="section-meta">${layer.boxEnabled?"Đang bật":"Đang tắt"}</span></summary><div class="section-body"><div class="control-title"><label class="toggle"><input type="checkbox" data-control="boxEnabled" ${layer.boxEnabled?"checked":""}> Bật hộp chữ</label></div><div class="box-presets"><button type="button" class="tool" data-box-preset="white">Hộp trắng</button><button type="button" class="tool" data-box-preset="dark">Hộp tối</button><button type="button" class="tool" data-box-preset="transparent">Trong suốt</button><button type="button" class="tool reset-text-box">Đặt lại hộp</button></div><div class="fields"><label class="field">Màu nền<input type="color" data-control="boxColor" value="${layer.boxColor}"></label><label class="field">Độ mờ nền <span class="range-value" data-layer-value-for="boxOpacity">${percent(layer.boxOpacity)}%</span><input type="range" min="0" max="100" data-control="boxOpacity" value="${percent(layer.boxOpacity)}"></label><label class="field">Màu viền<input type="color" data-control="boxBorderColor" value="${layer.boxBorderColor}"></label><label class="field">Độ dày viền <span class="range-value" data-layer-value-for="boxBorderWidth">${layer.boxBorderWidth}px</span><input type="range" min="0" max="40" step="1" data-control="boxBorderWidth" value="${layer.boxBorderWidth}"></label><label class="field">Độ mờ viền <span class="range-value" data-layer-value-for="boxBorderOpacity">${percent(layer.boxBorderOpacity)}%</span><input type="range" min="0" max="100" data-control="boxBorderOpacity" value="${percent(layer.boxBorderOpacity)}"></label><label class="field">Bo góc <span class="range-value" data-layer-value-for="boxRadius">${layer.boxRadius}px</span><input type="range" min="0" max="120" step="2" data-control="boxRadius" value="${layer.boxRadius}"></label><label class="field">Chiều rộng hộp <span class="range-value" data-layer-value-for="boxWidth">${layer.boxWidth}%</span><input type="range" min="20" max="96" step="1" data-control="boxWidth" value="${layer.boxWidth}"></label><label class="field">Đệm ngang <span class="range-value" data-layer-value-for="boxPaddingX">${layer.boxPaddingX}px</span><input type="range" min="0" max="120" step="2" data-control="boxPaddingX" value="${layer.boxPaddingX}"></label><label class="field">Đệm dọc <span class="range-value" data-layer-value-for="boxPaddingY">${layer.boxPaddingY}px</span><input type="range" min="0" max="80" step="2" data-control="boxPaddingY" value="${layer.boxPaddingY}"></label></div></div></details>`;

}
function cellPickerHtml(slide, data) {
  const ids = selectedIds(slide);
  if (ids.length <= 1) return "";
  const current = activeCell(slide);
  const buttons = ids.map((id, index) => {
    const custom = data.assetCrops?.[id] ? " ·" : "";
    return `<button type="button" class="tool pick-cell${id === current ? " active" : ""}" data-cell-pick="${esc(id)}">Ô ${index + 1}${custom}</button>`;
  }).join("");
  return `<div class="control-title"><span class="section-meta">Chọn ô để chỉnh riêng</span></div><div class="image-quick-tools">${buttons}<button type="button" class="tool reset-cell-crops">Bỏ chỉnh riêng</button></div>`;
}
function imageControlsHtml(data, slideId) {
  const slide = project.slides.find(item => item.id === slideId);
  const crop = activeCrop(slide, data);
  const percent = value => Math.round(value * 100), open = sectionIsOpen(slideId, "imageFrame");
  return `<details class="editor-section image-controls" data-editor-section="imageFrame" data-slide="${slideId}" ${open?"open":""}><summary><strong>Chỉnh ảnh và khung</strong><span class="section-meta">${data.frameWidth>0?"Có khung":"Ảnh cơ bản"}</span></summary><div class="section-body"><div class="control-title"><button type="button" class="tool reset-image">Đặt lại ảnh/khung</button></div>${cellPickerHtml(slide, data)}<div class="image-quick-tools"><button type="button" class="tool zoom-step" data-zoom-step="-0.2" title="Thu nhỏ">− Thu nhỏ</button><button type="button" class="tool zoom-step" data-zoom-step="0.2" title="Phóng to">+ Phóng to</button><button type="button" class="tool center-image">Về giữa</button><button type="button" class="tool fill-image">Lấp đầy khung</button><button type="button" class="tool fit-image">Vừa cả ảnh</button></div><p class="image-hint">Kéo trực tiếp trên ảnh để đổi vị trí (cần zoom &gt; 1×), giữ Ctrl/Cmd và lăn chuột hoặc chụm hai ngón để phóng to/thu nhỏ.</p><div class="fields"><label class="field">Zoom ảnh <span class="range-value" data-value-for="cropZoom">${crop.cropZoom.toFixed(1)}×</span><input type="range" min="1" max="4" step="0.05" data-control="cropZoom" value="${crop.cropZoom}"></label><label class="field">Kiểu vừa khung<select data-control="imageFit"><option value="cover" ${data.imageFit!=="contain"?"selected":""}>Lấp đầy (cắt bớt)</option><option value="contain" ${data.imageFit==="contain"?"selected":""}>Vừa cả ảnh (viền nền)</option></select></label><label class="field">Màu nền ảnh<input type="color" data-control="imageBackground" value="${data.imageBackground}"></label><label class="field toggle-field"><span>Lật ảnh</span><span class="flip-row"><label class="toggle"><input type="checkbox" data-control="imageFlipH" ${data.imageFlipH?"checked":""}> Ngang</label><label class="toggle"><input type="checkbox" data-control="imageFlipV" ${data.imageFlipV?"checked":""}> Dọc</label></span></label><label class="field">Trọng tâm ngang <span class="range-value" data-value-for="cropX">${Math.round(crop.cropX)}%</span><input type="range" min="0" max="100" data-control="cropX" value="${crop.cropX}"></label><label class="field">Trọng tâm dọc <span class="range-value" data-value-for="cropY">${Math.round(crop.cropY)}%</span><input type="range" min="0" max="100" data-control="cropY" value="${crop.cropY}"></label><label class="field">Độ sáng <span class="range-value" data-value-for="imageBrightness">${percent(data.imageBrightness)}%</span><input type="range" min="0.3" max="2" step="0.05" data-control="imageBrightness" value="${data.imageBrightness}"></label><label class="field">Tương phản <span class="range-value" data-value-for="imageContrast">${percent(data.imageContrast)}%</span><input type="range" min="0.3" max="2" step="0.05" data-control="imageContrast" value="${data.imageContrast}"></label><label class="field">Bão hòa <span class="range-value" data-value-for="imageSaturation">${percent(data.imageSaturation)}%</span><input type="range" min="0" max="2" step="0.05" data-control="imageSaturation" value="${data.imageSaturation}"></label><label class="field">Đen trắng <span class="range-value" data-value-for="imageGrayscale">${percent(data.imageGrayscale)}%</span><input type="range" min="0" max="100" step="1" data-control="imageGrayscale" value="${percent(data.imageGrayscale)}"></label><label class="field">Sắc độ <span class="range-value" data-value-for="imageHue">${Math.round(data.imageHue)}°</span><input type="range" min="-180" max="180" step="1" data-control="imageHue" value="${data.imageHue}"></label><label class="field">Làm mờ <span class="range-value" data-value-for="imageBlur">${data.imageBlur}px</span><input type="range" min="0" max="20" step="0.5" data-control="imageBlur" value="${data.imageBlur}"></label><label class="field">Màu viền<input type="color" data-control="frameColor" value="${data.frameColor}"></label><label class="field">Độ dày viền <span class="range-value" data-value-for="frameWidth">${data.frameWidth}px</span><input type="range" min="0" max="80" step="1" data-control="frameWidth" value="${data.frameWidth}"></label><label class="field">Khoảng cách khung <span class="range-value" data-value-for="frameInset">${data.frameInset}px</span><input type="range" min="0" max="360" step="2" data-control="frameInset" value="${data.frameInset}"></label><label class="field">Độ mờ khung <span class="range-value" data-value-for="frameOpacity">${percent(data.frameOpacity)}%</span><input type="range" min="0" max="100" step="1" data-control="frameOpacity" value="${percent(data.frameOpacity)}"></label><label class="field">Bo góc khung <span class="range-value" data-value-for="frameRadius">${data.frameRadius}px</span><input type="range" min="0" max="240" step="2" data-control="frameRadius" value="${data.frameRadius}"></label></div></div></details>`;

}
function decorateImageEditors() {
  document.querySelectorAll("[data-editor]").forEach(editor => {
    const data = drafts.get(editor.dataset.editor), fields = editor.querySelector(".fields");
    const index = selectedLayers.get(editor.dataset.editor) || 0, layer = data?.layers[index];
    if (data && fields && layer) fields.insertAdjacentHTML("afterend", textStyleControlsHtml(layer, editor.dataset.editor) + textBoxControlsHtml(layer, editor.dataset.editor) + imageControlsHtml(data, editor.dataset.editor));
  });
}
function editCard(slide) {
  const data = draft(slide); let active = selectedLayers.get(slide.id) ?? 0; if (!data.layers[active]) active = 0; selectedLayers.set(slide.id, active);
  const layer = data.layers[active] || defaultLayer(slide);
  const canUndo = (histories.get(slide.id) || []).length > 0, canRedo = (redos.get(slide.id) || []).length > 0;
  return `<article class="card" data-editor="${slide.id}" data-design-saved="${slide.designSaved && !designDirty.has(slide.id) ? "true" : "false"}"><div class="card-head"><div><div class="number">Slide ${slide.position}</div><h2>${esc(slide.headline)}</h2></div><span class="status">${data.layers.length} lớp chữ</span></div><div class="visual"><div class="preview-column"><div class="canvas" data-canvas="${slide.id}">${background(slide, data, assets, activeCell(slide))}<div class="safe-zone"></div>${data.layers.map((item, index) => layerHtml(item, index, index === active, textSelections.get(`${slide.id}:${index}`), directEditing.has(`${slide.id}:${index}`))).join("")}</div>${directToolbarHtml(layer,slide.id,active)}<div class="proof-bar"><button type="button" class="tool show-proof" data-slide="${slide.id}">Xem ảnh thật</button><small class="muted proof-status" data-proof-status="${slide.id}"></small></div></div><div><div class="tools"><button class="tool add-layer">+ Thêm chữ</button><button class="tool remove-layer">Xóa lớp</button><button class="tool undo" ${canUndo ? "" : "disabled"}>Hoàn tác</button><button class="tool redo" ${canRedo ? "" : "disabled"}>Làm lại</button><details class="apply-targets"><summary class="tool">Chọn slide để áp dụng kiểu</summary><div class="apply-target-menu"><div class="apply-target-actions"><button type="button" class="tool select-all-targets">Chọn tất cả</button><button type="button" class="tool clear-all-targets">Bỏ chọn</button></div>${project.slides.map(target=>`<label class="toggle"><input type="checkbox" class="style-target-slide" value="${target.id}" ${target.id===slide.id?"checked":""}> Slide ${target.position}: ${esc(target.headline.slice(0,34))}</label>`).join("")}<button type="button" class="action apply-selected-slides">Áp dụng kiểu</button></div></details></div><label class="field">Lớp chữ<select data-control="layer">${data.layers.map((item,index)=>`<option value="${index}" ${index===active?"selected":""}>${index+1}. ${esc(item.content.slice(0,30)||"Chữ mới")}</option>`).join("")}</select></label><div class="fields"><label class="field wide">Nội dung<textarea data-control="content">${esc(layer.content)}</textarea></label></div><button class="action save-design" data-slide="${slide.id}">Lưu thiết kế</button></div></div></article>`;
}

function videoPanelHtml(){
  const cfg=project.videoSettings||{},enabled=project.videoEnabled,voices=["Kore","Puck","Charon","Fenrir","Aoede","Leda","Orus","Zephyr","Achernar","Gacrux","Sulafat","Umbriel"],animations=[["none","Không hiển thị"],["static","Tĩnh"],["block","Bật lên"],["by-line","Theo dòng"],["by-word","Theo từ"],["typewriter","Gõ chữ"]];
  const voiceOptions=value=>voices.map(v=>`<option value="${v}" ${value===v?"selected":""}>${v}</option>`).join("");
  const animationOptions=value=>animations.map(([v,label])=>`<option value="${v}" ${value===v?"selected":""}>${label}</option>`).join("");
  const assetMap=new Map(project.assets.map(a=>[a.id,a])),firstSlide=project.slides.find(s=>(s.video||{}).enabled!==false)||project.slides[0],firstAsset=firstSlide&&assetMap.get((firstSlide.selectedAssetIds||[])[0]||firstSlide.selectedAssetId);
  const slidePicker=project.slides.map(slide=>{const v=slide.video||{},asset=assetMap.get((slide.selectedAssetIds||[])[0]||slide.selectedAssetId);return `<label class="video-slide-pick" data-pick-slide="${slide.id}"><input type="checkbox" data-video-pick="${slide.id}" ${v.enabled!==false?"checked":""}>${asset?`<img src="${esc(asset.publicUrl)}">`:""}<span>Slide ${slide.position}<strong>${esc(slide.headline)}</strong></span></label>`}).join("");
  const sceneRows=project.slides.map((slide,index)=>{const v=slide.video||{},asset=assetMap.get((slide.selectedAssetIds||[])[0]||slide.selectedAssetId),layers=slide.textLayers||[];
   return `<article class="timeline-scene" draggable="true" data-video-slide="${slide.id}" data-preview-image="${esc(asset?.publicUrl||"")}"><div class="timeline-handle" title="Kéo để sắp xếp">⋮⋮</div><label class="toggle"><input data-v="enabled" type="checkbox" ${v.enabled!==false?"checked":""}> Slide ${slide.position}</label><div class="timeline-thumb">${asset?`<img src="${esc(asset.publicUrl)}">`:""}</div><div class="timeline-main"><strong>${esc(slide.headline)}</strong><div class="timeline-bar" style="--scene-width:${Math.max(80,Number(v.duration||cfg.defaultSceneDuration||3)*55)}px"><span>${Number(v.duration||cfg.defaultSceneDuration||3).toFixed(1)}s</span></div><div class="layer-animation-list">${layers.map((layer,i)=>`<label>${esc(layer.role==="headline"?"Tiêu đề":layer.role==="body"?"Nội dung":`Lớp ${i+1}`)}<select data-layer-animation="${esc(layer.id||String(i))}">${animationOptions(v.layerAnimations?.[layer.id]||v.layerAnimations?.[String(i)]||layer.animation||v.textAnimation||cfg.textAnimation||"none")}</select></label>`).join("")}</div></div><div class="timeline-fields"><input data-v="order" type="hidden" value="${v.order??index}"><label>Thời lượng<input data-v="duration" type="number" min=".8" max="15" step=".1" value="${v.duration||cfg.defaultSceneDuration||3}"></label><label>Chuyển động<select data-v="motion"><option value="smart-ken-burns" ${["smart-ken-burns","ken-burns"].includes(v.motion)||(!v.motion&&cfg.smartKenBurns)?"selected":""}>Smart Ken Burns</option><option value="zoom-in" ${v.motion==="zoom-in"?"selected":""}>Zoom in</option><option value="zoom-out" ${v.motion==="zoom-out"?"selected":""}>Zoom out</option><option value="pan-left" ${v.motion==="pan-left"?"selected":""}>Pan trái</option><option value="pan-right" ${v.motion==="pan-right"?"selected":""}>Pan phải</option><option value="none" ${v.motion==="none"?"selected":""}>Đứng yên</option></select></label><label>Nhân vật<select data-v="speaker"><option value="speaker1">Giọng 1</option><option value="speaker2" ${v.speaker==="speaker2"?"selected":""}>Giọng 2</option></select></label><label>Trọng tâm X<input data-v="focusX" type="range" min="0" max="100" value="${v.focusX??slide.cropX??50}"></label><label>Trọng tâm Y<input data-v="focusY" type="range" min="0" max="100" value="${v.focusY??slide.cropY??50}"></label></div></article>`}).join("");
  return `<div class="video-editor" id="videoEditor"><aside class="video-preview-sticky"><div class="video-preview-head"><div><div class="number">VIDEO PREVIEW</div><strong id="videoPreviewTitle">${esc(firstSlide?.headline||"")}</strong></div><button id="toggleVideoControls" class="tool">Ẩn tùy chọn</button></div><div class="video-stage"><img id="videoStillPreview" src="${esc(firstAsset?.publicUrl||"")}"><div id="videoStillCaption">${esc(firstSlide?.headline||"")}</div><video id="videoPreviewPlayer" class="hidden" controls playsinline></video></div><div class="video-actions"><button id="startVideoRender" class="action" ${enabled?"":"disabled"}>Render video</button><span id="videoJobText" class="muted"></span><a id="videoDownload" class="action hidden">Tải MP4</a><button id="videoDelete" class="danger hidden">Xóa video ngay</button></div><div class="render-progress"><span id="videoJobProgress" style="width:0%"></span></div></aside>
  <main class="video-controls"><details class="editor-section" open><summary><strong>Cấu hình chung</strong><span class="section-meta">Remotion</span></summary><div class="section-body"><div class="card-head"><label class="toggle"><input id="videoEnabled" type="checkbox" ${enabled?"checked":""}> Bật video</label><label class="toggle"><input id="videoAutoTiming" type="checkbox" ${cfg.autoTiming!==false?"checked":""}> Căn cảnh theo TTS</label></div><div class="fields"><label class="field">Tỷ lệ<select id="videoAspect"><option value="vertical">9:16 TikTok/Reels</option><option value="square" ${cfg.aspectRatio==="square"?"selected":""}>1:1</option><option value="landscape" ${cfg.aspectRatio==="landscape"?"selected":""}>16:9</option></select></label><label class="field">Preset<select id="videoPreset"><option value="fashion">Fashion</option><option value="tiktok" ${cfg.preset==="tiktok"?"selected":""}>TikTok nhanh</option><option value="minimal" ${cfg.preset==="minimal"?"selected":""}>Tối giản</option><option value="editorial" ${cfg.preset==="editorial"?"selected":""}>Editorial</option></select></label><label class="field">Chuyển cảnh<select id="videoTransition"><option value="fade">Fade</option><option value="cut" ${cfg.transition==="cut"?"selected":""}>Cut</option><option value="slide" ${cfg.transition==="slide"?"selected":""}>Slide</option><option value="zoom" ${cfg.transition==="zoom"?"selected":""}>Zoom</option></select></label><label class="field">Animation mặc định<select id="videoTextAnimation">${animationOptions(cfg.textAnimation||"block")}</select></label><label class="field">Trễ giữa các lớp <strong id="videoLayerStaggerValue">${Number(cfg.layerStagger??.12).toFixed(2)}s</strong><input id="videoLayerStagger" type="range" min="0" max="1" step=".05" value="${cfg.layerStagger??.12}"></label><label class="toggle"><input id="videoSmartKenBurns" type="checkbox" ${cfg.smartKenBurns!==false?"checked":""}> Smart Ken Burns</label><label class="field">Cường độ Ken Burns <strong id="videoKenBurnsValue">${Math.round((cfg.kenBurnsIntensity??.14)*100)}%</strong><input id="videoKenBurns" type="range" min="4" max="35" value="${Math.round((cfg.kenBurnsIntensity??.14)*100)}"></label><label class="toggle"><input id="videoBeat" type="checkbox" ${cfg.beatSync?"checked":""}> Beat sync</label><label class="field">BPM<input id="videoBpm" type="number" min="40" max="240" value="${cfg.bpm||120}"></label></div></div></details>
  <details class="editor-section" open><summary><strong>Phụ đề động</strong><span class="section-meta">${cfg.subtitleStyle||"karaoke"}</span></summary><div class="section-body"><div class="fields"><label class="toggle"><input id="videoSubtitles" type="checkbox" ${cfg.subtitles?"checked":""}> Bật phụ đề</label><label class="toggle"><input id="videoShowSlideTitle" type="checkbox" ${cfg.showSlideTitle?"checked":""}> Hiện tiêu đề slide thay cho nội dung</label><label class="field">Kiểu<select id="videoSubtitleStyle"><option value="karaoke">Karaoke highlight</option><option value="word" ${cfg.subtitleStyle==="word"?"selected":""}>Từng từ</option><option value="pop" ${cfg.subtitleStyle==="pop"?"selected":""}>Hộp sáng</option><option value="static" ${cfg.subtitleStyle==="static"?"selected":""}>Tĩnh</option></select></label><label class="field">Font<select id="videoSubtitleFont">${fonts.map(font=>`<option ${font===(cfg.subtitleFont||"TikTok Sans")?"selected":""}>${font}</option>`).join("")}</select></label><label class="field">Màu chữ<input id="videoSubtitleColor" type="color" value="${cfg.subtitleColor||"#FFFFFF"}"></label><label class="field">Màu nền<input id="videoSubtitleBg" type="color" value="${cfg.subtitleBackgroundColor||"#000000"}"></label><label class="field">Cỡ chữ <strong id="videoSubtitleSizeValue">${cfg.subtitleSize||38}px</strong><input id="videoSubtitleSize" type="range" min="20" max="96" value="${cfg.subtitleSize||38}"></label><label class="field">Độ mờ nền <strong id="videoSubtitleOpacityValue">${Math.round((cfg.subtitleBackgroundOpacity??.72)*100)}%</strong><input id="videoSubtitleOpacity" type="range" min="0" max="100" value="${Math.round((cfg.subtitleBackgroundOpacity??.72)*100)}"></label><label class="field">Vị trí <strong id="videoSubtitlePositionValue">${cfg.subtitlePosition??88}%</strong><input id="videoSubtitlePosition" type="range" min="55" max="94" value="${cfg.subtitlePosition??88}"></label></div></div></details>
  <details class="editor-section" open><summary><strong>Chọn slide đưa vào video</strong><span class="section-meta">Theo mục 3 · Sửa ảnh</span></summary><div class="section-body"><div class="tools"><button id="selectAllVideoSlides" type="button" class="tool">Chọn tất cả</button><button id="clearAllVideoSlides" type="button" class="tool">Bỏ chọn</button></div><div class="video-slide-picker">${slidePicker}</div></div></details>
  <details class="editor-section"><summary><strong>Giọng đọc và nhạc</strong><span class="section-meta">${cfg.ttsProvider==="vertex"?"Vertex AI":"Google"}</span></summary><div class="section-body"><div class="fields"><label class="field wide">Nhạc nền<input id="videoAudio" value="${esc(cfg.audioUrl||"")}" placeholder="URL trực tiếp MP3, M4A, WAV hoặc MP4"><small>Không dán link trang TikTok/YouTube. Có thể tải MP3 trực tiếp bên dưới.</small></label><label class="field wide video-audio-upload">Tải MP3 từ máy<input id="videoAudioFile" type="file" accept=".mp3,audio/mpeg"><span><button id="uploadVideoAudio" type="button" class="tool">Tải MP3 lên</button> <small id="videoAudioUploadStatus"></small></span></label><label class="field">Âm lượng nhạc <strong id="videoVolumeValue">${Math.round((cfg.audioVolume??.6)*100)}%</strong><input id="videoVolume" type="range" min="0" max="100" value="${Math.round((cfg.audioVolume??.6)*100)}"></label><label class="toggle"><input id="videoTts" type="checkbox" ${cfg.ttsEnabled?"checked":""}> Bật giọng đọc TTS</label><label class="field">Nhà cung cấp<select id="videoTtsProvider"><option value="google">Google TTS</option><option value="vertex" ${["vertex","gemini"].includes(cfg.ttsProvider)?"selected":""}>Vertex AI Gemini TTS</option></select></label><label class="field">Tốc độ <strong id="videoTtsSpeedValue">${Number(cfg.ttsSpeed||1).toFixed(2)}x</strong><input id="videoTtsSpeed" type="range" min=".5" max="2" step=".05" value="${cfg.ttsSpeed||1}"></label><label class="field">Âm lượng giọng <strong id="videoTtsVolumeValue">${Math.round((cfg.ttsVolume??1)*100)}%</strong><input id="videoTtsVolume" type="range" min="0" max="100" value="${Math.round((cfg.ttsVolume??1)*100)}"></label><label class="field">Model<select id="geminiModel"><option value="gemini-2.5-flash-tts">Gemini 2.5 Flash TTS</option><option value="gemini-2.5-pro-tts" ${cfg.geminiModel==="gemini-2.5-pro-tts"?"selected":""}>Gemini 2.5 Pro TTS</option><option value="gemini-3.1-flash-tts-preview" ${cfg.geminiModel==="gemini-3.1-flash-tts-preview"?"selected":""}>Gemini 3.1 Flash TTS</option></select></label><label class="toggle"><input id="geminiMultiSpeaker" type="checkbox" ${cfg.geminiMultiSpeaker?"checked":""}> Hai giọng</label><label class="field">Nhân vật 1<input id="geminiSpeaker1Name" value="${esc(cfg.geminiSpeaker1Name||"Người dẫn")}"></label><label class="field">Giọng 1<select id="geminiSpeaker1Voice">${voiceOptions(cfg.geminiSpeaker1Voice||"Kore")}</select></label><label class="field">Nhân vật 2<input id="geminiSpeaker2Name" value="${esc(cfg.geminiSpeaker2Name||"Khách mời")}"></label><label class="field">Giọng 2<select id="geminiSpeaker2Voice">${voiceOptions(cfg.geminiSpeaker2Voice||"Puck")}</select></label><label class="field wide">Phong cách giọng<textarea id="geminiStylePrompt">${esc(cfg.geminiStylePrompt||"")}</textarea></label></div></div></details>
  <details class="editor-section timeline-section" open><summary><strong>Timeline chỉnh sửa</strong><span class="section-meta">Kéo để sắp xếp</span></summary><div class="section-body"><div class="timeline-ruler"><span>0s</span><span>Cảnh và lớp chữ</span><span id="timelineTotal"></span></div><div class="video-timeline" id="videoTimeline">${sceneRows}</div></div></details><button id="saveVideo" class="action">Lưu thiết kế video</button></main></div>`;
}

function render() {
  assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const contentDone = project.contentStatus === "APPROVED", imagesDone = project.slides.every(slide => slide.imageApproved);
  $("meta").textContent = `${project.title} · ${project.slides.length} slide`;
  $("content").innerHTML = project.slides.map(contentCard).join("") + `<div class="card"><button id="approveContent" class="action" ${contentDone ? "disabled" : ""}>${contentDone ? "Nội dung đã duyệt ✓" : "Duyệt toàn bộ nội dung"}</button></div>`;
  $("images").innerHTML = project.slides.map(imageCard).join("");
  $("edit").innerHTML = `<div class="card brand-kit"><label class="field">Font thương hiệu<select id="brandFont">${fonts.map(font=>`<option ${font===project.brandKit?.font?"selected":""}>${font}</option>`).join("")}</select></label><label class="field">Màu thương hiệu<input id="brandColor" type="color" value="${project.brandKit?.color || "#FFFFFF"}"></label><button id="saveBrand" class="action">Lưu và áp dụng tất cả</button></div>` + project.slides.map(editCard).join("");
  $("video").innerHTML = videoPanelHtml();
  $("download").innerHTML = `<div class="card"><h2>Render bộ ảnh</h2><p class="muted">Render chạy nền; có thể theo dõi tiến trình trước khi tải.</p><button id="startRender" class="action">Bắt đầu render</button><div id="jobBox" class="hidden"><p id="jobText"></p><div class="render-progress"><span id="jobProgress" style="width:0%"></span></div><a id="jobDownload" class="action hidden" href="#">Tải ZIP</a></div></div>`;
  document.querySelectorAll(".step").forEach(button => { const locked = button.dataset.view === "images" && !contentDone || ["edit","download","video"].includes(button.dataset.view) && !imagesDone; button.disabled = locked; button.classList.toggle("active", button.dataset.view === view); button.classList.toggle("done", button.dataset.view === "content" ? contentDone : button.dataset.view === "images" ? imagesDone : false); });
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === view));
  decorateImageEditors();
  bindDrag();
  if(view==="video"){updateTimelineTotal();const firstVideoRow=document.querySelector(".timeline-scene");if(firstVideoRow)showVideoScene(firstVideoRow);}
}

// Payload thiết kế của một slide. Nút "Lưu thiết kế" và nút "Xem ảnh thật" dùng chung hàm này
// để ảnh render thử luôn phản ánh đúng thứ sắp được lưu.
function designPayload(slide, data) {
  const primary = data.layers[0] || defaultLayer(slide);
  return {
    cropX:data.cropX, cropY:data.cropY, cropZoom:data.cropZoom, assetCrops:data.assetCrops||{},
    imageBrightness:data.imageBrightness, imageContrast:data.imageContrast, imageSaturation:data.imageSaturation,
    imageBlur:data.imageBlur, imageGrayscale:data.imageGrayscale, imageHue:data.imageHue,
    imageFit:data.imageFit, imageBackground:data.imageBackground,
    imageFlipH:data.imageFlipH, imageFlipV:data.imageFlipV, frameInset:data.frameInset, frameWidth:data.frameWidth,
    frameColor:data.frameColor, frameOpacity:data.frameOpacity, frameRadius:data.frameRadius,
    textEnabled:true, overlayText:primary.content, textFont:primary.font, textSize:primary.size, textPosition:"center",
    textColor:primary.color, textAlign:primary.align, textX:primary.x, textY:primary.y, textLayers:data.layers
  };
}

async function json(url, options = {}) { const response = await fetch(url, options); const value = await response.json(); if (!response.ok) throw new Error(value.message || "Yêu cầu thất bại"); return value; }
async function saveContent(slide, box) {
  const get = name => box.querySelector(`[data-f="${name}"]`), headline = get("headline").value.trim(), body = get("body").value.trim();
  const layers = syncContentLayers(slide, headline, body), layer = layers.find(item => item.role === "headline") || layers[0];
  const updated = await json(`/api/projects/${projectId}/slides/${slide.id}/content`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ headline, body, textEnabled:true, overlayText:headline, textFont:layer.font, textSize:Math.max(32,Math.min(160,Math.round(layer.size))), textPosition:"center", textColor:layer.color, textAlign:layer.align, textX:layer.x, textY:layer.y, textLayers:layers }) });
  drafts.delete(slide.id); histories.delete(slide.id); redos.delete(slide.id);
  return updated;
}
async function saveAllContent() {
  for (const slideId of project.slides.map(slide => slide.id)) {
    const slide = project.slides.find(item => item.id === slideId), box = document.querySelector(`[data-content="${slideId}"]`);
    project = await saveContent(slide, box);
  }
}
async function approveImages(slideId, assetIds, mode) { project = await json(`/api/projects/${projectId}/slides/${slideId}/approve-assets`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ assetIds, mode }) }); render(); }

$("workflow").onclick = async event => { const button=event.target.closest(".step"); if(!button||button.disabled)return; try{if(view==="video")await saveAllVideoFromDom();view=button.dataset.view;render();}catch(error){alert("Khong the luu cau hinh video: "+error.message);} };
$("content").onclick = async event => { try { const save = event.target.closest(".save-content"); if (save) { save.disabled=true; save.textContent="Đang lưu…"; const slide = project.slides.find(item=>item.id===save.dataset.slide); project = await saveContent(slide, document.querySelector(`[data-content="${slide.id}"]`)); render(); } if (event.target.id === "approveContent") { const approve=event.target; approve.disabled=true; approve.textContent="Đang lưu toàn bộ nội dung…"; await saveAllContent(); project = await json(`/api/projects/${projectId}/approve-content`, { method:"POST" }); view = "images"; render(); } } catch (error) { alert(error.message); render(); } };
$("images").onclick = event => { const one = event.target.closest("[data-one]"); if (one) return approveImages(one.dataset.slide, [one.dataset.one], "crop").catch(error=>alert(error.message)); const grid = event.target.closest(".approve-grid"); if (grid) return approveImages(grid.dataset.slide, [...(picks.get(grid.dataset.slide)||[])], "grid").catch(error=>alert(error.message)); };
$("images").onchange = event => { const input = event.target.closest("[data-pick]"); if (!input) return; const set = picks.get(input.dataset.slide) || new Set(); input.checked ? set.size < 10 && set.add(input.dataset.pick) : set.delete(input.dataset.pick); picks.set(input.dataset.slide, set); render(); };

$("edit").addEventListener("toggle", event => {
  const details = event.target.closest("[data-editor-section]");
  if (details) sectionStates.set(`${details.dataset.slide}:${details.dataset.editorSection}`, details.open);
}, true);
$("edit").onchange = event => { const editor = event.target.closest("[data-editor]"); if (!editor) return; if (event.target.dataset.control === "layer") { selectedLayers.set(editor.dataset.editor, Number(event.target.value)); render(); } };
$("edit").onfocusin = event => { const editor = event.target.closest("[data-editor]"); if (editor && event.target.dataset.control && event.target.dataset.control !== "layer") remember(editor.dataset.editor, false); };
function captureTextSelection(event) {
  const input = event.target.closest('[data-control="content"]'), editor = event.target.closest("[data-editor]");
  if (!input || !editor) return;
  const slideId = editor.dataset.editor, index = selectedLayers.get(slideId) || 0;
  const selection = { start:input.selectionStart, end:input.selectionEnd };
  textSelections.set(`${slideId}:${index}`, selection);
  const data = drafts.get(slideId), preview = editor.querySelector(`[data-layer="${index}"]`);
  if (data?.layers[index] && preview) preview.innerHTML = richTextHtml(withTextBox(data.layers[index]), selection);
}
$("edit").onselect = captureTextSelection;
$("edit").onkeyup = captureTextSelection;
$("edit").oninput = event => {
  const editor = event.target.closest("[data-editor]"); if (!editor) return; const slideId = editor.dataset.editor, data = drafts.get(slideId), index = selectedLayers.get(slideId) || 0, layer = data.layers[index];
  const editable = event.target.closest(".layer[contenteditable=true]");
  if (editable) {
    const layerIndex = Number(editable.dataset.layer), target = data.layers[layerIndex], content = editable.innerText.replace(/\r/g,"");
    target.sizeRanges = remapSizeRanges(String(target.content||""),content,target.sizeRanges||[]);
    target.styleRanges = remapSizeRanges(String(target.content||""),content,target.styleRanges||[]);
    target.content = content; markDesignDirty(slideId); return;
  }
  const directControl = event.target.dataset.directStyle;
  if (directControl) {
    let value = event.target.value;
    if (directControl === "size") value = Math.max(24,Math.min(220,Number(value)||72));
    if (directControl === "boxColor") { remember(slideId); layer.boxColor=value; render(); return; }
    applyDirectStyle(slideId,index,{[directControl]:value}); return;
  }
  const control = event.target.dataset.control; if (!control) return;
  markDesignDirty(slideId);
  if (control === "boxEnabled") layer.boxEnabled = event.target.checked;
  else if (["boxBorderWidth","boxRadius","boxPaddingX","boxPaddingY","boxWidth"].includes(control)) layer[control] = Number(event.target.value);
  else if (["boxOpacity","boxBorderOpacity"].includes(control)) layer[control] = Number(event.target.value)/100;
  else if (["boxColor","boxBorderColor"].includes(control)) layer[control] = event.target.value.toUpperCase();
  else if (["cropX","cropY","cropZoom"].includes(control)) setCrop(project.slides.find(item=>item.id===slideId), data, { [control]: Number(event.target.value) });
  else if (["imageBrightness","imageContrast","imageSaturation","imageBlur","imageHue","frameInset","frameWidth","frameRadius"].includes(control)) data[control] = Number(event.target.value);
  else if (["imageGrayscale","frameOpacity"].includes(control)) data[control] = Number(event.target.value)/100;
  else if (["imageFlipH","imageFlipV"].includes(control)) data[control] = event.target.checked;
  else if (control === "imageFit") data.imageFit = event.target.value === "contain" ? "contain" : "cover";
  else if (control === "imageBackground") data.imageBackground = event.target.value.toUpperCase();
  else if (control === "frameColor") data.frameColor = event.target.value.toUpperCase();
  else if (control === "size" || control === "rotation") layer[control] = Number(event.target.value);
  else if (control === "opacity") layer.opacity = Number(event.target.value)/100;
  else if (control === "content") {
    layer.sizeRanges = remapSizeRanges(String(layer.content || ""), event.target.value, layer.sizeRanges || []);
    layer.styleRanges = remapSizeRanges(String(layer.content || ""), event.target.value, layer.styleRanges || []);
    layer.content = event.target.value;
  } else layer[control] = event.target.value;
  const layerOutput = editor.querySelector(`[data-layer-value-for="${control}"]`);
  if (layerOutput) {
    if (["boxOpacity","boxBorderOpacity"].includes(control)) layerOutput.textContent = `${Math.round(layer[control]*100)}%`;
    else if (control === "boxWidth") layerOutput.textContent = `${layer[control]}%`;
    else layerOutput.textContent = `${layer[control]}px`;
  }
  const output = editor.querySelector(`[data-value-for="${control}"]`);
  if (output) {
    const slideForCrop = project.slides.find(item=>item.id===slideId), currentCrop = activeCrop(slideForCrop, data);
    if (["cropX","cropY"].includes(control)) output.textContent = `${Math.round(currentCrop[control])}%`;
    else if (control === "cropZoom") output.textContent = `${currentCrop.cropZoom.toFixed(1)}×`;
    else if (["imageBrightness","imageContrast","imageSaturation","imageGrayscale","frameOpacity"].includes(control)) output.textContent = `${Math.round(data[control]*100)}%`;
    else if (control === "imageHue") output.textContent = `${Math.round(data.imageHue)}°`;
    else output.textContent = `${data[control]}px`;
  }
  const slide = project.slides.find(item=>item.id===slideId); const canvas = editor.querySelector(".canvas"); canvas.outerHTML = `<div class="canvas" data-canvas="${slide.id}">${background(slide, data, assets, activeCell(slide))}<div class="safe-zone"></div>${data.layers.map((item,i)=>layerHtml(item,i,i===index,textSelections.get(`${slide.id}:${i}`),directEditing.has(`${slide.id}:${i}`))).join("")}</div>`; bindDrag();
};
$("edit").ondblclick = event => {
  const layerElement = event.target.closest(".layer"), editor = event.target.closest("[data-editor]");
  if (!layerElement || !editor) return;
  event.preventDefault();
  const slideId = editor.dataset.editor, index = Number(layerElement.dataset.layer);
  startDirectEditing(slideId,index);
};
$("edit").onclick = async event => {
  try {
    const editor = event.target.closest("[data-editor]");
    if (!editor) return; const slideId = editor.dataset.editor, slide = project.slides.find(item=>item.id===slideId), data = drafts.get(slideId), index = selectedLayers.get(slideId)||0;
    if (event.target.closest(".direct-start")) { startDirectEditing(slideId,index); return; }
    if (event.target.closest(".direct-finish")) { directEditing.delete(`${slideId}:${index}`); textSelections.delete(`${slideId}:${index}`); render(); return; }
    if (event.target.closest(".direct-bold")) { const selection=textSelections.get(`${slideId}:${index}`), current=styleAt(data.layers[index],selection?.start||0); applyDirectStyle(slideId,index,{weight:String(current.weight)==="400"?"700":"400"}); return; }
    if (event.target.closest(".direct-underline")) { const selection=textSelections.get(`${slideId}:${index}`), current=styleAt(data.layers[index],selection?.start||0); applyDirectStyle(slideId,index,{underline:!Boolean(current.underline)}); return; }
    if (event.target.closest(".direct-box")) { remember(slideId); data.layers[index].boxEnabled=!data.layers[index].boxEnabled; render(); return; }
    if (event.target.closest(".add-layer")) { remember(slideId); data.layers.push(withTextBox({ id:crypto.randomUUID(), role:"custom", content:"Chữ mới", enabled:true, font:project.brandKit?.font||"TikTok Sans", size:72, x:50, y:50, color:project.brandKit?.color||"#FFFFFF", align:"center", opacity:1, rotation:0 })); selectedLayers.set(slideId,data.layers.length-1); render(); return; }
    if (event.target.closest(".remove-layer")) { if (data.layers.length > 1) { remember(slideId); data.layers.splice(index,1); selectedLayers.set(slideId,Math.max(0,index-1)); render(); } return; }
    if (event.target.closest(".undo")) { const history=histories.get(slideId)||[], redo=redos.get(slideId)||[]; if(history.length){redo.push(JSON.stringify(data));redos.set(slideId,redo);drafts.set(slideId,JSON.parse(history.pop()));render();} return; }
    if (event.target.closest(".redo")) { const redo=redos.get(slideId)||[], history=histories.get(slideId)||[]; if(redo.length){history.push(JSON.stringify(data));histories.set(slideId,history);drafts.set(slideId,JSON.parse(redo.pop()));render();} return; }
    if (event.target.closest(".apply-selected-style")) {
      const input = editor.querySelector('[data-control="content"]'), selection = textSelections.get(`${slideId}:${index}`) || { start:input.selectionStart, end:input.selectionEnd };
      if (!selection || selection.end <= selection.start) { alert("Hãy bôi đen đoạn chữ cần định dạng trong ô Nội dung."); return; }
      const sizeInput = editor.querySelector("[data-selection-size]").value;
      const range = { start:selection.start, end:selection.end };
      if (sizeInput) range.size = Math.max(24,Math.min(220,Number(sizeInput)||72));
      const font = editor.querySelector("[data-selection-font]").value;
      const weight = editor.querySelector("[data-selection-weight]").value;
      if (font) range.font = font;
      if (weight) range.weight = weight;
      range.underline = editor.querySelector("[data-selection-underline]").checked;
      remember(slideId); data.layers[index].styleRanges = [...(data.layers[index].styleRanges||[]), range]; render(); return;
    }
    if (event.target.closest(".clear-selected-styles")) { remember(slideId); data.layers[index].sizeRanges = []; data.layers[index].styleRanges = []; render(); return; }
    const boxPreset = event.target.closest("[data-box-preset]")?.dataset.boxPreset;
    if (boxPreset) {
      remember(slideId);
      const presets = {
        white: { boxEnabled:true, boxColor:"#FFFFFF", boxOpacity:0.92, boxBorderColor:"#4A4A4A", boxBorderWidth:2, boxBorderOpacity:0.8, boxRadius:28, boxPaddingX:36, boxPaddingY:22, boxWidth:78 },
        dark: { boxEnabled:true, boxColor:"#111111", boxOpacity:0.72, boxBorderColor:"#FFFFFF", boxBorderWidth:1, boxBorderOpacity:0.35, boxRadius:28, boxPaddingX:36, boxPaddingY:22, boxWidth:78 },
        transparent: { boxEnabled:true, boxColor:"#FFFFFF", boxOpacity:0, boxBorderColor:"#FFFFFF", boxBorderWidth:2, boxBorderOpacity:0.8, boxRadius:20, boxPaddingX:28, boxPaddingY:18, boxWidth:78 }
      };
      Object.assign(data.layers[index], presets[boxPreset]); render(); return;
    }
    if (event.target.closest(".reset-text-box")) { remember(slideId); Object.assign(data.layers[index], withTextBox()); render(); return; }
    if (event.target.closest(".reset-image")) { remember(slideId); Object.assign(data, imageDefaults()); render(); return; }
    const cellPick = event.target.closest("[data-cell-pick]")?.dataset.cellPick;
    if (cellPick) { activeCells.set(slideId, cellPick); render(); return; }
    if (event.target.closest(".reset-cell-crops")) { remember(slideId); data.assetCrops = {}; render(); return; }
    const zoomStep = event.target.closest("[data-zoom-step]")?.dataset.zoomStep;
    if (zoomStep) { remember(slideId); setCrop(slide, data, { cropZoom: Number(Math.max(1, Math.min(MAX_ZOOM, activeCrop(slide, data).cropZoom + Number(zoomStep))).toFixed(2)) }); render(); return; }
    if (event.target.closest(".center-image")) { remember(slideId); setCrop(slide, data, { cropX: 50, cropY: 50 }); render(); return; }
    if (event.target.closest(".fill-image")) { remember(slideId); data.imageFit = "cover"; render(); return; }
    if (event.target.closest(".fit-image")) { remember(slideId); data.imageFit = "contain"; setCrop(slide, data, { cropZoom: 1, cropX: 50, cropY: 50 }); render(); return; }
    if (event.target.closest(".select-all-targets")) { editor.querySelectorAll(".style-target-slide").forEach(input=>input.checked=true); return; }
    if (event.target.closest(".clear-all-targets")) { editor.querySelectorAll(".style-target-slide").forEach(input=>input.checked=false); return; }
    if (event.target.closest(".apply-selected-slides")) {
      const targetIds = [...editor.querySelectorAll(".style-target-slide:checked")].map(input=>input.value);
      if (!targetIds.length) { alert("Hãy chọn ít nhất một slide."); return; }
      const source = withTextBox(data.layers[index]);
      const styleKeys = ["font","size","weight","underline","x","y","color","align","opacity","rotation","boxEnabled","boxColor","boxOpacity","boxBorderColor","boxBorderWidth","boxBorderOpacity","boxRadius","boxPaddingX","boxPaddingY","boxWidth"];
      for (const targetId of targetIds) {
        const targetSlide = project.slides.find(item=>item.id===targetId), targetData = draft(targetSlide);
        const targetIndex = Math.min(index, targetData.layers.length-1), targetLayer = targetData.layers[targetIndex];
        remember(targetId);
        for (const key of styleKeys) targetLayer[key] = structuredClone(source[key]);
      }
      render(); return;
    }
    if (event.target.closest(".show-proof")) { await showProof(slide, data, editor); return; }
    if (event.target.closest(".close-proof")) { editor.querySelector(".proof-overlay")?.remove(); return; }
    if (event.target.closest(".save-design")) {
      project = await json(`/api/projects/${projectId}/slides/${slideId}/design`, {
        method:"PATCH", headers:{"Content-Type":"application/json"},
        body:JSON.stringify(designPayload(slide, data))
      });
      designDirty.delete(slideId); drafts.delete(slideId); histories.delete(slideId); redos.delete(slideId); render();
    }
  } catch(error){alert(error.message);}
};

// Đồng bộ thanh trượt với thao tác kéo/lăn chuột trên khung xem trước mà không phải render lại cả trang.
function syncImageControls(slideId) {
  const editor = document.querySelector(`[data-editor="${slideId}"]`), data = drafts.get(slideId);
  const slide = project.slides.find(item => item.id === slideId);
  if (!editor || !data || !slide) return;
  const crop = activeCrop(slide, data);
  for (const control of ["cropX", "cropY", "cropZoom"]) {
    const input = editor.querySelector(`[data-control="${control}"]`);
    if (input) input.value = crop[control];
    const output = editor.querySelector(`[data-value-for="${control}"]`);
    if (output) output.textContent = control === "cropZoom" ? `${crop.cropZoom.toFixed(1)}×` : `${Math.round(crop[control])}%`;
  }
}

let wheelTimer = null, wheelSlideId = null;
function bindCanvasPan() {
  document.querySelectorAll(".canvas").forEach(canvas => {
    const surface = canvas.querySelector("[data-canvas-bg]"), slideId = canvas.dataset.canvas, data = drafts.get(slideId);
    const slide = project.slides.find(item => item.id === slideId);
    if (!surface || !data || !slide) return;
    // Chỉ vẽ lại ô đang chỉnh, các ô khác giữ nguyên.
    const applyZoom = () => {
      const crop = activeCrop(slide, data), id = activeCell(slide);
      const cell = surface.querySelector(`[data-cell="${CSS.escape(id)}"] .canvas-zoom`);
      if (!cell) return;
      cell.style.transform = `scale(${crop.cropZoom})`;
      cell.style.transformOrigin = `${crop.cropX}% ${crop.cropY}%`;
    };
    surface.onpointerdown = event => {
      if (event.target.closest(".layer")) return;
      // Kéo trên một ô khác thì chuyển sang chỉnh ô đó.
      const cellId = event.target.closest("[data-cell]")?.dataset.cell;
      if (cellId && cellId !== activeCell(slide)) { activeCells.set(slideId, cellId); render(); return; }
      const rect = canvas.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
      const origin = activeCrop(slide, data), originX = origin.cropX, originY = origin.cropY;
      let moved = false;
      surface.setPointerCapture(event.pointerId);
      surface.classList.add("panning");
      surface.onpointermove = move => {
        const dx = move.clientX - startX, dy = move.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) { remember(slideId); moved = true; }
        // Ở mức zoom z, khung nhìn chỉ trượt được (z-1) lần chiều rộng khung, nên 1px kéo tay
        // tương ứng 100/(rộng·(z-1)) phần trăm trọng tâm.
        const span = activeCrop(slide, data).cropZoom - 1;
        if (span <= .001) return;
        setCrop(slide, data, {
          cropX: Number(Math.max(0, Math.min(100, originX - dx / (rect.width * span) * 100)).toFixed(2)),
          cropY: Number(Math.max(0, Math.min(100, originY - dy / (rect.height * span) * 100)).toFixed(2))
        });
        applyZoom(); syncImageControls(slideId);
      };
      const finish = () => { surface.onpointermove = null; surface.classList.remove("panning"); if (moved) render(); };
      surface.onpointerup = finish; surface.onpointercancel = finish;
    };
    surface.onwheel = event => {
      // Chỉ thu phóng khi giữ Ctrl/Cmd (cũng là tín hiệu của thao tác chụm hai ngón trên trackpad),
      // để lăn chuột thường vẫn cuộn trang như bình thường.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = activeCrop(slide, data).cropZoom;
      const next = Number(Math.max(1, Math.min(MAX_ZOOM, current - event.deltaY * .0015)).toFixed(2));
      if (next === current) return;
      if (wheelSlideId !== slideId) { remember(slideId); wheelSlideId = slideId; }
      setCrop(slide, data, { cropZoom: next });
      applyZoom(); syncImageControls(slideId);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelSlideId = null; }, 400);
    };
  });
}

// Gọi renderer thật của server với đúng thiết kế đang sửa rồi hiện ảnh chồng lên khung xem trước.
// Đây là cách chắc chắn nhất để thấy ảnh sắp tải về, và cũng để lộ ngay nếu preview lệch bản render.
async function showProof(slide, data, editor) {
  const status = editor.querySelector(`[data-proof-status="${slide.id}"]`);
  const button = editor.querySelector(".show-proof");
  if (button) button.disabled = true;
  if (status) status.textContent = "Đang render…";
  try {
    const response = await fetch(`/api/projects/${projectId}/slides/${slide.id}/preview-render`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ design: designPayload(slide, data) })
    });
    if (!response.ok) throw new Error((await response.json().catch(()=>({}))).message || "Không render được ảnh thật");
    const url = URL.createObjectURL(await response.blob());
    editor.querySelector(".proof-overlay")?.remove();
    const canvas = editor.querySelector(".canvas");
    canvas.insertAdjacentHTML("afterend", `<div class="proof-overlay"><img src="${url}" alt="Ảnh render thật"><div class="proof-actions"><span>Ảnh render thật · 1080×1920</span><button type="button" class="tool close-proof">Đóng</button></div></div>`);
    // Ảnh đã nằm trong DOM nên thu hồi được URL tạm.
    editor.querySelector(".proof-overlay img").onload = () => URL.revokeObjectURL(url);
    if (status) status.textContent = "";
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

function bindDrag() { bindCanvasPan(); document.querySelectorAll(".canvas").forEach(canvas => canvas.querySelectorAll(".layer").forEach(element => { element.onpointerdown = event => { if (element.isContentEditable) return; const slideId=canvas.dataset.canvas,index=Number(element.dataset.layer),data=drafts.get(slideId),startX=event.clientX,startY=event.clientY;let moved=false;selectedLayers.set(slideId,index);canvas.querySelectorAll(".layer").forEach((item,i)=>item.classList.toggle("active",i===index));element.setPointerCapture(event.pointerId);element.onpointermove=move=>{if(Math.hypot(move.clientX-startX,move.clientY-startY)<4&&!moved)return;if(!moved){remember(slideId);moved=true;}const rect=canvas.getBoundingClientRect(),x=Math.max(3,Math.min(97,(move.clientX-rect.left)/rect.width*100)),y=Math.max(3,Math.min(97,(move.clientY-rect.top)/rect.height*100));data.layers[index].x=Number(x.toFixed(2));data.layers[index].y=Number(y.toFixed(2));element.style.left=`${x}%`;element.style.top=`${y}%`;};element.onpointerup=()=>{element.onpointermove=null;if(moved)render();};}; })); }

$("download").onclick = async event => { if (event.target.id !== "startRender") return; try { const job=await json(`/api/projects/${projectId}/render-jobs`,{method:"POST"});$("jobBox").classList.remove("hidden");pollJob(job.id); } catch(error){alert(error.message);} };
async function pollJob(id){clearTimeout(renderTimer);try{const job=await json(`/api/render-jobs/${id}`);$("jobText").textContent=`${job.status} · ${job.progress}%`;$("jobProgress").style.width=`${job.progress}%`;if(job.status==="READY"){$("jobDownload").href=job.downloadUrl;$("jobDownload").classList.remove("hidden");return;}if(job.status==="FAILED")throw Error(job.error);renderTimer=setTimeout(()=>pollJob(id),1000);}catch(error){alert(error.message);}}

document.addEventListener("click", async event => {
  if (event.target.id !== "saveBrand") return;
  try {
    project = await json(`/api/projects/${projectId}/brand-kit`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ font:$("brandFont").value, color:$("brandColor").value.toUpperCase(), applyToAll:true }) });
    drafts.clear(); render();
  } catch (error) { alert(error.message); }
});
document.addEventListener("selectionchange", () => {
  const selection = window.getSelection(), layer = selection?.anchorNode?.parentElement?.closest?.(".layer[contenteditable=true]");
  if (!layer) return;
  const editor = layer.closest("[data-editor]"), index = Number(layer.dataset.layer), range = directSelection(layer);
  if (editor && range) textSelections.set(`${editor.dataset.editor}:${index}`, range);
});
(async()=>{try{if(!projectId)throw Error("Thiếu projectId");project=await json(`/api/projects/${projectId}`);$("loading").classList.add("hidden");$("app").classList.remove("hidden");render();}catch(error){$("loading").textContent=error.message;}})();

function videoSettingsFromDom(){return {aspectRatio:$("videoAspect").value,fps:30,defaultSceneDuration:3,transition:$("videoTransition").value,motion:"zoom-in",textAnimation:$("videoTextAnimation").value,audioUrl:$("videoAudio").value,audioVolume:Number($("videoVolume").value)/100,subtitles:$("videoSubtitles").checked,subtitleStyle:$("videoSubtitleStyle").value,subtitlePosition:Number($("videoSubtitlePosition").value),subtitleFont:$("videoSubtitleFont").value,subtitleColor:$("videoSubtitleColor").value,subtitleBackgroundColor:$("videoSubtitleBg").value,subtitleBackgroundOpacity:Number($("videoSubtitleOpacity").value)/100,subtitleSize:Number($("videoSubtitleSize").value),showSlideTitle:$("videoShowSlideTitle").checked,beatSync:$("videoBeat").checked,bpm:Number($("videoBpm").value),ttsEnabled:$("videoTts").checked,ttsProvider:$("videoTtsProvider").value,ttsVoice:"vi-VN-Neural2-D",ttsSpeed:Number($("videoTtsSpeed").value),ttsVolume:Number($("videoTtsVolume").value)/100,geminiModel:$("geminiModel").value,geminiMultiSpeaker:$("geminiMultiSpeaker").checked,geminiSpeaker1Name:$("geminiSpeaker1Name").value||"Nguoi dan",geminiSpeaker1Voice:$("geminiSpeaker1Voice").value,geminiSpeaker2Name:$("geminiSpeaker2Name").value||"Khach moi",geminiSpeaker2Voice:$("geminiSpeaker2Voice").value,geminiStylePrompt:$("geminiStylePrompt").value,autoTiming:$("videoAutoTiming").checked,smartKenBurns:$("videoSmartKenBurns").checked,kenBurnsIntensity:Number($("videoKenBurns").value)/100,layerStagger:Number($("videoLayerStagger").value),preset:$("videoPreset").value};}
function sceneSettingsFromRow(row){const get=n=>row.querySelector(`[data-v="${n}"]`),layerAnimations={};row.querySelectorAll("[data-layer-animation]").forEach(input=>layerAnimations[input.dataset.layerAnimation]=input.value);return {enabled:get("enabled").checked,order:Number(get("order").value),duration:Number(get("duration").value),motion:get("motion").value,speaker:get("speaker").value,focusX:Number(get("focusX").value),focusY:Number(get("focusY").value),kenBurnsIntensity:Number($("videoKenBurns").value)/100,subtitleStyle:$("videoSubtitleStyle").value,subtitlePosition:Number($("videoSubtitlePosition").value),subtitleFont:$("videoSubtitleFont").value,subtitleColor:$("videoSubtitleColor").value,subtitleBackgroundColor:$("videoSubtitleBg").value,subtitleBackgroundOpacity:Number($("videoSubtitleOpacity").value)/100,subtitleSize:Number($("videoSubtitleSize").value),showSlideTitle:$("videoShowSlideTitle").checked,layerAnimations};}
async function saveVideoProjectFromDom(){project=await json(`/api/projects/${projectId}/video`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:$("videoEnabled").checked,settings:videoSettingsFromDom()})});}
async function saveVideoSceneRow(row){project=await json(`/api/projects/${projectId}/slides/${row.dataset.videoSlide}/video`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(sceneSettingsFromRow(row))});}
async function saveAllVideoFromDom(){if(!$("videoAspect"))return;await saveVideoProjectFromDom();for(const row of document.querySelectorAll("[data-video-slide]"))await saveVideoSceneRow(row);}
let videoAutosaveTimer,draggedVideoScene;
function updateTimelineTotal(){const rows=[...document.querySelectorAll("[data-video-slide]")],total=rows.reduce((sum,row)=>sum+Number(row.querySelector('[data-v="duration"]').value||0),0);if($("timelineTotal"))$("timelineTotal").textContent=total.toFixed(1)+"s";rows.forEach((row,i)=>row.querySelector('[data-v="order"]').value=i);}
function scheduleVideoAutosave(){clearTimeout(videoAutosaveTimer);updateTimelineTotal();videoAutosaveTimer=setTimeout(()=>saveAllVideoFromDom().catch(error=>console.error("Video autosave failed",error)),700);}
function updateSubtitlePreview(slide){const caption=$("videoStillCaption");if(!caption)return;const text=$("videoShowSlideTitle")?.checked?slide?.headline:(slide?.video?.caption??slide?.body??"");caption.textContent=text||"";caption.style.display=$("videoSubtitles")?.checked&&text?"block":"none";caption.style.fontFamily=$("videoSubtitleFont")?.value||"TikTok Sans";caption.style.color=$("videoSubtitleColor")?.value||"#FFFFFF";caption.style.fontSize=((Number($("videoSubtitleSize")?.value||38)/38)*16)+"px";caption.style.background=rgba($("videoSubtitleBg")?.value||"#000000",Number($("videoSubtitleOpacity")?.value||72)/100);caption.style.bottom=(100-Number($("videoSubtitlePosition")?.value||88))+"%";}
function showVideoScene(row){if(!row)return;document.querySelectorAll(".timeline-scene").forEach(x=>x.classList.toggle("active",x===row));const slide=project.slides.find(x=>x.id===row.dataset.videoSlide);if($("videoStillPreview"))$("videoStillPreview").src=row.dataset.previewImage||"";if($("videoPreviewTitle"))$("videoPreviewTitle").textContent=slide?.headline||"";updateSubtitlePreview(slide);}
$("video").oninput=event=>{if(event.target.id==="videoVolume")$("videoVolumeValue").textContent=event.target.value+"%";if(event.target.id==="videoTtsSpeed")$("videoTtsSpeedValue").textContent=Number(event.target.value).toFixed(2)+"x";if(event.target.id==="videoTtsVolume")$("videoTtsVolumeValue").textContent=event.target.value+"%";if(event.target.id==="videoLayerStagger")$("videoLayerStaggerValue").textContent=Number(event.target.value).toFixed(2)+"s";if(event.target.id==="videoKenBurns")$("videoKenBurnsValue").textContent=event.target.value+"%";if(event.target.id==="videoSubtitlePosition")$("videoSubtitlePositionValue").textContent=event.target.value+"%";if(event.target.id==="videoSubtitleSize")$("videoSubtitleSizeValue").textContent=event.target.value+"px";if(event.target.id==="videoSubtitleOpacity")$("videoSubtitleOpacityValue").textContent=event.target.value+"%";const row=event.target.closest("[data-video-slide]")||document.querySelector(".timeline-scene.active")||document.querySelector(".timeline-scene");if(row)showVideoScene(row);scheduleVideoAutosave();};
$("video").onchange=event=>{const pick=event.target.closest("[data-video-pick]");if(pick){const row=document.querySelector(`[data-video-slide="${pick.dataset.videoPick}"]`);if(row){row.querySelector('[data-v="enabled"]').checked=pick.checked;showVideoScene(row);}}const enabled=event.target.closest('[data-v="enabled"]');if(enabled){const row=enabled.closest("[data-video-slide]"),pickInput=document.querySelector(`[data-video-pick="${row.dataset.videoSlide}"]`);if(pickInput)pickInput.checked=enabled.checked;}scheduleVideoAutosave();};
$("video").ondragstart=event=>{draggedVideoScene=event.target.closest("[data-video-slide]");if(draggedVideoScene)draggedVideoScene.classList.add("dragging");};
$("video").ondragover=event=>{const row=event.target.closest("[data-video-slide]");if(row&&draggedVideoScene&&row!==draggedVideoScene){event.preventDefault();const rect=row.getBoundingClientRect();row.parentNode.insertBefore(draggedVideoScene,event.clientY<rect.top+rect.height/2?row:row.nextSibling);updateTimelineTotal();}};
$("video").ondragend=()=>{draggedVideoScene?.classList.remove("dragging");draggedVideoScene=null;scheduleVideoAutosave();};
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden"&&view==="video")saveAllVideoFromDom().catch(()=>{});});
$("video").onclick=async event=>{try{const row=event.target.closest("[data-video-slide]");if(row)showVideoScene(row);const pickCard=event.target.closest("[data-pick-slide]");if(pickCard){const targetRow=document.querySelector(`[data-video-slide="${pickCard.dataset.pickSlide}"]`);if(targetRow)showVideoScene(targetRow);}if(event.target.id==="selectAllVideoSlides"||event.target.id==="clearAllVideoSlides"){const checked=event.target.id==="selectAllVideoSlides";document.querySelectorAll("[data-video-pick]").forEach(input=>input.checked=checked);document.querySelectorAll('[data-v="enabled"]').forEach(input=>input.checked=checked);scheduleVideoAutosave();return;}if(event.target.id==="toggleVideoControls"){$("videoEditor").classList.toggle("controls-hidden");event.target.textContent=$("videoEditor").classList.contains("controls-hidden")?"Hiện tùy chọn":"Ẩn tùy chọn";return;}if(event.target.id==="saveVideo"){await saveAllVideoFromDom();render();return;}if(event.target.id==="uploadVideoAudio"){const file=$("videoAudioFile").files[0];if(!file)throw Error("Hãy chọn một file MP3.");if(file.size>25*1024*1024)throw Error("MP3 tối đa 25 MB.");event.target.disabled=true;$("videoAudioUploadStatus").textContent="Đang tải…";try{const result=await json(`/api/projects/${projectId}/video-audio`,{method:"POST",headers:{"Content-Type":"audio/mpeg"},body:file});$("videoAudio").value=result.url;$("videoAudioUploadStatus").textContent="Đã tải · "+(result.size/1024/1024).toFixed(1)+" MB";scheduleVideoAutosave();}finally{event.target.disabled=false;}return;}if(event.target.id==="startVideoRender"){const audio=$("videoAudio").value.trim();if(audio){let parsed;try{parsed=new URL(audio);}catch{throw Error("URL nhạc nền không hợp lệ.");}if(/(^|\.)tiktok\.com$/iu.test(parsed.hostname)||/(^|\.)youtube\.com$/iu.test(parsed.hostname)||parsed.hostname==="youtu.be")throw Error("Link trang TikTok/YouTube không phải file nhạc trực tiếp. Hãy tải MP3 lên hoặc dùng URL CDN.");}await saveAllVideoFromDom();render();const job=await json(`/api/projects/${projectId}/video-render-jobs`,{method:"POST"});pollVideoJob(job.id);return;}if(event.target.id==="videoDelete"){const id=event.target.dataset.job;if(!id||!confirm("Xóa vĩnh viễn video này khỏi VPS?"))return;await json(`/api/video-render-jobs/${id}`,{method:"DELETE"});$("videoPreviewPlayer").removeAttribute("src");$("videoPreviewPlayer").load();$("videoPreviewPlayer").classList.add("hidden");$("videoDownload").classList.add("hidden");$("videoDelete").classList.add("hidden");$("videoJobText").textContent="Đã xóa video";}}catch(e){alert(e.message)}};

async function pollVideoJob(id){try{const job=await json(`/api/video-render-jobs/${id}`);$("videoJobText").textContent=`${job.status} · ${job.progress}%`;$("videoJobProgress").style.width=`${job.progress}%`;if(job.status==="READY"){$("videoPreviewPlayer").src=job.downloadUrl;$("videoPreviewPlayer").classList.remove("hidden");$("videoDownload").href=job.downloadUrl;$("videoDownload").classList.remove("hidden");$("videoDelete").dataset.job=job.id;$("videoDelete").classList.remove("hidden");$("videoJobText").textContent="READY · 100% · Tự xóa sau 7 ngày";return}if(job.status==="FAILED")throw Error(job.error);setTimeout(()=>pollVideoJob(id),1500)}catch(e){alert(e.message)}}
