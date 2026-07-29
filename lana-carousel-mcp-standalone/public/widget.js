const params = new URLSearchParams(location.search);
const projectId = params.get("projectId");
const $ = id => document.getElementById(id);
const fonts = ["TikTok Sans", "Montserrat", "Poppins", "Bebas Neue", "Roboto", "Playfair Display", "Courier New"];
let project, assets, view = "content", renderTimer;
const picks = new Map(), drafts = new Map(), selectedLayers = new Map(), histories = new Map(), redos = new Map(), sectionStates = new Map(), textSelections = new Map();
const esc = (value = "") => String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[char]);

function selectedIds(slide) { return slide.selectedAssetIds?.length ? slide.selectedAssetIds : [slide.selectedAssetId].filter(Boolean); }
function candidateAssets(slide) { return [...new Set([...(slide.candidateAssetIds || []), slide.selectedAssetId].filter(Boolean))].map(id => assets.get(id)).filter(Boolean); }
function withTextBox(layer = {}) {
  return {
    boxEnabled: false, boxColor: "#FFFFFF", boxOpacity: 0.9,
    boxBorderColor: "#333333", boxBorderWidth: 0, boxBorderOpacity: 1,
    boxRadius: 24, boxPaddingX: 32, boxPaddingY: 20, boxWidth: 80, sizeRanges: [], styleRanges: [],
    ...layer
  };
}
function defaultLayer(slide) { return withTextBox({ id: crypto.randomUUID(), role: "headline", content: slide.headline || slide.overlayText, enabled: slide.textEnabled, font: slide.textFont || "TikTok Sans", size: slide.textSize || 72, x: slide.textX || 50, y: slide.textY || 42, color: slide.textColor || "#FFFFFF", align: slide.textAlign || "center", opacity: 1, rotation: 0 }); }
function defaultBodyLayer(slide) { return withTextBox({ id: crypto.randomUUID(), role: "body", content: slide.body || "", enabled: Boolean(slide.body), font: slide.textFont || "TikTok Sans", size: 42, x: 50, y: 66, color: slide.textColor || "#FFFFFF", align: "center", opacity: 0.95, rotation: 0 }); }
function initialLayers(slide) { return [defaultLayer(slide), defaultBodyLayer(slide)]; }
function imageDefaults(slide = {}) {
  return {
    cropX: slide.cropX ?? 50, cropY: slide.cropY ?? 50, cropZoom: slide.cropZoom ?? 1,
    imageBrightness: slide.imageBrightness ?? 1, imageContrast: slide.imageContrast ?? 1,
    imageSaturation: slide.imageSaturation ?? 1, imageBlur: slide.imageBlur ?? 0,
    imageGrayscale: slide.imageGrayscale ?? 0, frameInset: slide.frameInset ?? 40,
    frameWidth: slide.frameWidth ?? 0, frameColor: slide.frameColor || "#FFFFFF",
    frameOpacity: slide.frameOpacity ?? 1, frameRadius: slide.frameRadius ?? 0
  };
}
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
function remember(slideId) {
  const history = histories.get(slideId) || [];
  history.push(JSON.stringify(drafts.get(slideId)));
  if (history.length > 30) history.shift();
  histories.set(slideId, history);
  redos.set(slideId, []);
}

function contentCard(slide) { return `<article class="card" data-content="${slide.id}"><div class="number">Slide ${slide.position}</div><div class="fields"><label class="field wide">Tiêu đề<input data-f="headline" value="${esc(slide.headline)}"></label><label class="field wide">Nội dung<textarea data-f="body">${esc(slide.body)}</textarea></label></div><button class="action save-content" data-slide="${slide.id}">Lưu nội dung</button></article>`; }
function imageCard(slide) {
  const approved = new Set(selectedIds(slide)), chosen = picks.get(slide.id) || new Set();
  const cards = candidateAssets(slide).map(asset => `<article class="candidate${approved.has(asset.id) && slide.imageApproved ? " selected" : ""}"><img src="${esc(asset.publicUrl)}"><div class="candidate-actions"><button data-one="${asset.id}" data-slide="${slide.id}">${approved.size === 1 && approved.has(asset.id) && slide.imageApproved ? "Đã duyệt ✓" : "Duyệt ảnh này"}</button><label class="pick"><input type="checkbox" data-pick="${asset.id}" data-slide="${slide.id}" ${chosen.has(asset.id) ? "checked" : ""}> Chọn ghép lưới</label></div></article>`).join("");
  return `<article class="card"><div class="card-head"><div><div class="number">Slide ${slide.position}</div><h2>${esc(slide.headline)}</h2></div><span class="status${slide.imageApproved ? " done" : ""}">${slide.imageApproved ? "Đã duyệt" : "Chờ duyệt"}</span></div><div class="candidate-grid">${cards}</div><div class="bar"><small class="muted">${candidateAssets(slide).length}/10 ảnh · Chọn lưới: ${chosen.size}</small><button class="action approve-grid" data-slide="${slide.id}" ${chosen.size < 2 ? "disabled" : ""}>Duyệt ghép lưới (${chosen.size})</button></div></article>`;
}
function rgba(hex, opacity) {
  const value = /^#[0-9a-f]{6}$/iu.test(hex) ? hex.slice(1) : "FFFFFF";
  return `rgba(${parseInt(value.slice(0,2),16)},${parseInt(value.slice(2,4),16)},${parseInt(value.slice(4,6),16)},${opacity})`;
}
function frameHtml(data) {
  if (!data.frameWidth) return "";
  return `<div class="image-frame" style="inset:${data.frameInset/10.8}cqw;border-width:${Math.max(0.15,data.frameWidth/10.8)}cqw;border-color:${rgba(data.frameColor,data.frameOpacity)};border-radius:${data.frameRadius/10.8}cqw"></div>`;
}
function background(slide, data) {
  const ids = selectedIds(slide), columns = ids.length <= 2 ? 1 : ids.length <= 6 ? 2 : 3;
  const filter = `brightness(${data.imageBrightness}) contrast(${data.imageContrast}) saturate(${data.imageSaturation}) grayscale(${data.imageGrayscale*100}%) blur(${data.imageBlur/10.8}cqw)`;
  return `<div class="canvas-bg" style="grid-template-columns:repeat(${columns},1fr);filter:${filter}">${ids.map(id => `<div><img src="${esc(assets.get(id)?.publicUrl || "")}" style="transform:scale(${data.cropZoom});transform-origin:${data.cropX}% ${data.cropY}%"></div>`).join("")}</div>${frameHtml(data)}`;

}
function normalizedStyleRanges(layer) {
  const length = String(layer.content || "").length;
  const legacy = (layer.sizeRanges || []).map(range => ({ ...range, size:range.size }));
  return [...legacy, ...(layer.styleRanges || [])].map(range => ({
    start: Math.max(0, Math.min(length, Math.round(Number(range.start) || 0))),
    end: Math.max(0, Math.min(length, Math.round(Number(range.end) || 0))),
    ...(range.size == null ? {} : { size:Math.max(24, Math.min(220, Math.round(Number(range.size) || layer.size || 72))) }),
    ...(range.font ? { font:String(range.font).slice(0,100) } : {}),
    ...(range.weight ? { weight:["400","500","600","700","800","900"].includes(String(range.weight)) ? String(range.weight) : "700" } : {}),
    ...(range.underline == null ? {} : { underline:Boolean(range.underline) })
  })).filter(range => range.end > range.start);
}
function normalizedSizeRanges(layer) {
  return normalizedStyleRanges(layer).filter(range => range.size != null);
}
function styleAt(layer, index) {
  const style = { size:layer.size || 72, font:layer.font || "TikTok Sans", weight:String(layer.weight || "700"), underline:Boolean(layer.underline) };
  for (const range of normalizedStyleRanges(layer)) if (index >= range.start && index < range.end) Object.assign(style, {
    ...(range.size == null ? {} : { size:range.size }),
    ...(range.font ? { font:range.font } : {}),
    ...(range.weight ? { weight:range.weight } : {}),
    ...(range.underline == null ? {} : { underline:range.underline })
  });
  return style;
}
function richTextHtml(layer, selection = null) {
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
      html += `<span ${style.selected?'class="text-selection-preview"':""} style="font-size:${style.size/10.8}cqw;font-family:'${esc(style.font)}',sans-serif;font-weight:${style.weight};${decoration}${highlight}">${esc(content.slice(start,index))}</span>`;
      start = index; style = next;
    }
  }
  return html;
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
function layerHtml(rawLayer, index, active, selection = null) {
  const layer = withTextBox(rawLayer);
  const boxStyle = layer.boxEnabled ? `width:${layer.boxWidth}%;padding:${layer.boxPaddingY/10.8}cqw ${layer.boxPaddingX/10.8}cqw;background:${rgba(layer.boxColor,layer.boxOpacity)};border:${layer.boxBorderWidth/10.8}cqw solid ${rgba(layer.boxBorderColor,layer.boxBorderOpacity)};border-radius:${layer.boxRadius/10.8}cqw;text-shadow:none;` : "";
  return `<div class="layer${active ? " active" : ""}" data-layer="${index}" style="left:${layer.x}%;top:${layer.y}%;font-family:'${esc(layer.font)}',sans-serif;font-size:${layer.size/10.8}cqw;font-weight:${layer.weight||700};text-decoration:${layer.underline?"underline":"none"};color:${layer.color};text-align:${layer.align};opacity:${layer.opacity};rotate:${layer.rotation}deg;${boxStyle}">${richTextHtml(layer, active ? selection : null)}</div>`;
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
function imageControlsHtml(data, slideId) {
  const percent = value => Math.round(value * 100), open = sectionIsOpen(slideId, "imageFrame");
  return `<details class="editor-section image-controls" data-editor-section="imageFrame" data-slide="${slideId}" ${open?"open":""}><summary><strong>Chỉnh ảnh và khung</strong><span class="section-meta">${data.frameWidth>0?"Có khung":"Ảnh cơ bản"}</span></summary><div class="section-body"><div class="control-title"><button type="button" class="tool reset-image">Đặt lại ảnh/khung</button></div><div class="fields"><label class="field">Zoom ảnh <span class="range-value" data-value-for="cropZoom">${data.cropZoom.toFixed(1)}×</span><input type="range" min="1" max="3" step="0.1" data-control="cropZoom" value="${data.cropZoom}"></label><label class="field">Trọng tâm ngang <span class="range-value" data-value-for="cropX">${Math.round(data.cropX)}%</span><input type="range" min="0" max="100" data-control="cropX" value="${data.cropX}"></label><label class="field">Trọng tâm dọc <span class="range-value" data-value-for="cropY">${Math.round(data.cropY)}%</span><input type="range" min="0" max="100" data-control="cropY" value="${data.cropY}"></label><label class="field">Độ sáng <span class="range-value" data-value-for="imageBrightness">${percent(data.imageBrightness)}%</span><input type="range" min="0.3" max="2" step="0.05" data-control="imageBrightness" value="${data.imageBrightness}"></label><label class="field">Tương phản <span class="range-value" data-value-for="imageContrast">${percent(data.imageContrast)}%</span><input type="range" min="0.3" max="2" step="0.05" data-control="imageContrast" value="${data.imageContrast}"></label><label class="field">Bão hòa <span class="range-value" data-value-for="imageSaturation">${percent(data.imageSaturation)}%</span><input type="range" min="0" max="2" step="0.05" data-control="imageSaturation" value="${data.imageSaturation}"></label><label class="field">Đen trắng <span class="range-value" data-value-for="imageGrayscale">${percent(data.imageGrayscale)}%</span><input type="range" min="0" max="100" step="1" data-control="imageGrayscale" value="${percent(data.imageGrayscale)}"></label><label class="field">Làm mờ <span class="range-value" data-value-for="imageBlur">${data.imageBlur}px</span><input type="range" min="0" max="20" step="0.5" data-control="imageBlur" value="${data.imageBlur}"></label><label class="field">Màu viền<input type="color" data-control="frameColor" value="${data.frameColor}"></label><label class="field">Độ dày viền <span class="range-value" data-value-for="frameWidth">${data.frameWidth}px</span><input type="range" min="0" max="80" step="1" data-control="frameWidth" value="${data.frameWidth}"></label><label class="field">Khoảng cách khung <span class="range-value" data-value-for="frameInset">${data.frameInset}px</span><input type="range" min="0" max="360" step="2" data-control="frameInset" value="${data.frameInset}"></label><label class="field">Độ mờ khung <span class="range-value" data-value-for="frameOpacity">${percent(data.frameOpacity)}%</span><input type="range" min="0" max="100" step="1" data-control="frameOpacity" value="${percent(data.frameOpacity)}"></label><label class="field">Bo góc khung <span class="range-value" data-value-for="frameRadius">${data.frameRadius}px</span><input type="range" min="0" max="240" step="2" data-control="frameRadius" value="${data.frameRadius}"></label></div></div></details>`;

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
  return `<article class="card" data-editor="${slide.id}"><div class="card-head"><div><div class="number">Slide ${slide.position}</div><h2>${esc(slide.headline)}</h2></div><span class="status">${data.layers.length} lớp chữ</span></div><div class="visual"><div class="canvas" data-canvas="${slide.id}">${background(slide, data)}<div class="safe-zone"></div>${data.layers.map((item, index) => layerHtml(item, index, index === active, textSelections.get(`${slide.id}:${index}`))).join("")}</div><div><div class="tools"><button class="tool add-layer">+ Thêm chữ</button><button class="tool remove-layer">Xóa lớp</button><button class="tool undo" ${canUndo ? "" : "disabled"}>Hoàn tác</button><button class="tool redo" ${canRedo ? "" : "disabled"}>Làm lại</button><details class="apply-targets"><summary class="tool">Chọn slide để áp dụng kiểu</summary><div class="apply-target-menu"><div class="apply-target-actions"><button type="button" class="tool select-all-targets">Chọn tất cả</button><button type="button" class="tool clear-all-targets">Bỏ chọn</button></div>${project.slides.map(target=>`<label class="toggle"><input type="checkbox" class="style-target-slide" value="${target.id}" ${target.id===slide.id?"checked":""}> Slide ${target.position}: ${esc(target.headline.slice(0,34))}</label>`).join("")}<button type="button" class="action apply-selected-slides">Áp dụng kiểu</button></div></details></div><label class="field">Lớp chữ<select data-control="layer">${data.layers.map((item,index)=>`<option value="${index}" ${index===active?"selected":""}>${index+1}. ${esc(item.content.slice(0,30)||"Chữ mới")}</option>`).join("")}</select></label><div class="fields"><label class="field wide">Nội dung<textarea data-control="content">${esc(layer.content)}</textarea></label></div><button class="action save-design" data-slide="${slide.id}">Lưu thiết kế</button></div></div></article>`;
}

function render() {
  assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const contentDone = project.contentStatus === "APPROVED", imagesDone = project.slides.every(slide => slide.imageApproved);
  $("meta").textContent = `${project.title} · ${project.slides.length} slide`;
  $("content").innerHTML = project.slides.map(contentCard).join("") + `<div class="card"><button id="approveContent" class="action" ${contentDone ? "disabled" : ""}>${contentDone ? "Nội dung đã duyệt ✓" : "Duyệt toàn bộ nội dung"}</button></div>`;
  $("images").innerHTML = project.slides.map(imageCard).join("");
  $("edit").innerHTML = `<div class="card brand-kit"><label class="field">Font thương hiệu<select id="brandFont">${fonts.map(font=>`<option ${font===project.brandKit?.font?"selected":""}>${font}</option>`).join("")}</select></label><label class="field">Màu thương hiệu<input id="brandColor" type="color" value="${project.brandKit?.color || "#FFFFFF"}"></label><button id="saveBrand" class="action">Lưu và áp dụng tất cả</button></div>` + project.slides.map(editCard).join("");
  $("download").innerHTML = `<div class="card"><h2>Render bộ ảnh</h2><p class="muted">Render chạy nền; có thể theo dõi tiến trình trước khi tải.</p><button id="startRender" class="action">Bắt đầu render</button><div id="jobBox" class="hidden"><p id="jobText"></p><div class="render-progress"><span id="jobProgress" style="width:0%"></span></div><a id="jobDownload" class="action hidden" href="#">Tải ZIP</a></div></div>`;
  document.querySelectorAll(".step").forEach(button => { const locked = button.dataset.view === "images" && !contentDone || ["edit","download"].includes(button.dataset.view) && !imagesDone; button.disabled = locked; button.classList.toggle("active", button.dataset.view === view); button.classList.toggle("done", button.dataset.view === "content" ? contentDone : button.dataset.view === "images" ? imagesDone : false); });
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === view));
  decorateImageEditors();
  bindDrag();
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

$("workflow").onclick = event => { const button = event.target.closest(".step"); if (button && !button.disabled) { view = button.dataset.view; render(); } };
$("content").onclick = async event => { try { const save = event.target.closest(".save-content"); if (save) { save.disabled=true; save.textContent="Đang lưu…"; const slide = project.slides.find(item=>item.id===save.dataset.slide); project = await saveContent(slide, document.querySelector(`[data-content="${slide.id}"]`)); render(); } if (event.target.id === "approveContent") { const approve=event.target; approve.disabled=true; approve.textContent="Đang lưu toàn bộ nội dung…"; await saveAllContent(); project = await json(`/api/projects/${projectId}/approve-content`, { method:"POST" }); view = "images"; render(); } } catch (error) { alert(error.message); render(); } };
$("images").onclick = event => { const one = event.target.closest("[data-one]"); if (one) return approveImages(one.dataset.slide, [one.dataset.one], "crop").catch(error=>alert(error.message)); const grid = event.target.closest(".approve-grid"); if (grid) return approveImages(grid.dataset.slide, [...(picks.get(grid.dataset.slide)||[])], "grid").catch(error=>alert(error.message)); };
$("images").onchange = event => { const input = event.target.closest("[data-pick]"); if (!input) return; const set = picks.get(input.dataset.slide) || new Set(); input.checked ? set.size < 10 && set.add(input.dataset.pick) : set.delete(input.dataset.pick); picks.set(input.dataset.slide, set); render(); };

$("edit").addEventListener("toggle", event => {
  const details = event.target.closest("[data-editor-section]");
  if (details) sectionStates.set(`${details.dataset.slide}:${details.dataset.editorSection}`, details.open);
}, true);
$("edit").onchange = event => { const editor = event.target.closest("[data-editor]"); if (!editor) return; if (event.target.dataset.control === "layer") { selectedLayers.set(editor.dataset.editor, Number(event.target.value)); render(); } };
$("edit").onfocusin = event => { const editor = event.target.closest("[data-editor]"); if (editor && event.target.dataset.control && event.target.dataset.control !== "layer") remember(editor.dataset.editor); };
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
  const editor = event.target.closest("[data-editor]"); if (!editor) return; const slideId = editor.dataset.editor, data = drafts.get(slideId), index = selectedLayers.get(slideId) || 0, layer = data.layers[index], control = event.target.dataset.control; if (!control) return;
  if (control === "boxEnabled") layer.boxEnabled = event.target.checked;
  else if (["boxBorderWidth","boxRadius","boxPaddingX","boxPaddingY","boxWidth"].includes(control)) layer[control] = Number(event.target.value);
  else if (["boxOpacity","boxBorderOpacity"].includes(control)) layer[control] = Number(event.target.value)/100;
  else if (["boxColor","boxBorderColor"].includes(control)) layer[control] = event.target.value.toUpperCase();
  else if (["cropX","cropY","cropZoom","imageBrightness","imageContrast","imageSaturation","imageBlur","frameInset","frameWidth","frameRadius"].includes(control)) data[control] = Number(event.target.value);
  else if (["imageGrayscale","frameOpacity"].includes(control)) data[control] = Number(event.target.value)/100;
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
    if (["imageBrightness","imageContrast","imageSaturation","imageGrayscale","frameOpacity","cropX","cropY"].includes(control)) output.textContent = `${Math.round(data[control]*100)/(["cropX","cropY"].includes(control)?100:1)}%`;
    else if (control === "cropZoom") output.textContent = `${data.cropZoom.toFixed(1)}×`;
    else output.textContent = `${data[control]}px`;
  }
  const slide = project.slides.find(item=>item.id===slideId); const canvas = editor.querySelector(".canvas"); canvas.outerHTML = `<div class="canvas" data-canvas="${slide.id}">${background(slide,data)}<div class="safe-zone"></div>${data.layers.map((item,i)=>layerHtml(item,i,i===index,textSelections.get(`${slide.id}:${i}`))).join("")}</div>`; bindDrag();
};
$("edit").onclick = async event => {
  try {
    const editor = event.target.closest("[data-editor]");
    if (event.target.id === "saveBrand") { project = await json(`/api/projects/${projectId}/brand-kit`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ font:$("brandFont").value, color:$("brandColor").value.toUpperCase(), applyToAll:true }) }); drafts.clear(); render(); return; }
    if (!editor) return; const slideId = editor.dataset.editor, slide = project.slides.find(item=>item.id===slideId), data = drafts.get(slideId), index = selectedLayers.get(slideId)||0;
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
    if (event.target.closest(".save-design")) {
      project = await json(`/api/projects/${projectId}/slides/${slideId}/crop`, { method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({cropX:data.cropX,cropY:data.cropY,cropZoom:data.cropZoom,imageBrightness:data.imageBrightness,imageContrast:data.imageContrast,imageSaturation:data.imageSaturation,imageBlur:data.imageBlur,imageGrayscale:data.imageGrayscale,frameInset:data.frameInset,frameWidth:data.frameWidth,frameColor:data.frameColor,frameOpacity:data.frameOpacity,frameRadius:data.frameRadius}) });
      const primary=data.layers[0]||defaultLayer(slide); project=await json(`/api/projects/${projectId}/slides/${slideId}/content`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({headline:slide.headline,body:slide.body,textEnabled:true,overlayText:primary.content,textFont:primary.font,textSize:primary.size,textPosition:"center",textColor:primary.color,textAlign:primary.align,textX:primary.x,textY:primary.y,textLayers:data.layers})}); drafts.delete(slideId); histories.delete(slideId); redos.delete(slideId); render();
    }
  } catch(error){alert(error.message);}
};

function bindDrag() { document.querySelectorAll(".canvas").forEach(canvas => canvas.querySelectorAll(".layer").forEach(element => { element.onpointerdown = event => { const slideId=canvas.dataset.canvas,index=Number(element.dataset.layer),data=drafts.get(slideId);selectedLayers.set(slideId,index);remember(slideId);element.setPointerCapture(event.pointerId);element.onpointermove=move=>{const rect=canvas.getBoundingClientRect(),x=Math.max(3,Math.min(97,(move.clientX-rect.left)/rect.width*100)),y=Math.max(3,Math.min(97,(move.clientY-rect.top)/rect.height*100));data.layers[index].x=Number(x.toFixed(2));data.layers[index].y=Number(y.toFixed(2));element.style.left=`${x}%`;element.style.top=`${y}%`;};element.onpointerup=()=>{element.onpointermove=null;render();};}; })); }

$("download").onclick = async event => { if (event.target.id !== "startRender") return; try { const job=await json(`/api/projects/${projectId}/render-jobs`,{method:"POST"});$("jobBox").classList.remove("hidden");pollJob(job.id); } catch(error){alert(error.message);} };
async function pollJob(id){clearTimeout(renderTimer);try{const job=await json(`/api/render-jobs/${id}`);$("jobText").textContent=`${job.status} · ${job.progress}%`;$("jobProgress").style.width=`${job.progress}%`;if(job.status==="READY"){$("jobDownload").href=job.downloadUrl;$("jobDownload").classList.remove("hidden");return;}if(job.status==="FAILED")throw Error(job.error);renderTimer=setTimeout(()=>pollJob(id),1000);}catch(error){alert(error.message);}}

(async()=>{try{if(!projectId)throw Error("Thiếu projectId");project=await json(`/api/projects/${projectId}`);$("loading").classList.add("hidden");$("app").classList.remove("hidden");render();}catch(error){$("loading").textContent=error.message;}})();
