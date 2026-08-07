from pathlib import Path

ROOT = Path('lana-carousel-mcp-standalone')

# db.js: persist design save state and invalidate it whenever lower-level content/image mutations happen.
db_path = ROOT / 'src/db.js'
db = db_path.read_text()
old = '  text_layers: "TEXT",\n  video_settings: "TEXT"'
new = '  text_layers: "TEXT",\n  design_saved_at: "TEXT",\n  video_settings: "TEXT"'
if db.count(old) != 1:
    raise SystemExit('db slide column anchor mismatch')
db = db.replace(old, new, 1)
replacements = {
    "updateSlideCrop: db.prepare(`UPDATE slides SET crop_x=@crop_x,crop_y=@crop_y,crop_zoom=@crop_zoom,image_brightness=@image_brightness,image_contrast=@image_contrast,image_saturation=@image_saturation,image_blur=@image_blur,image_grayscale=@image_grayscale,frame_inset=@frame_inset,frame_width=@frame_width,frame_color=@frame_color,frame_opacity=@frame_opacity,frame_radius=@frame_radius,render_status='DIRTY',updated_at=@updated_at WHERE id=@id AND project_id=@project_id`),":
    "updateSlideCrop: db.prepare(`UPDATE slides SET crop_x=@crop_x,crop_y=@crop_y,crop_zoom=@crop_zoom,image_brightness=@image_brightness,image_contrast=@image_contrast,image_saturation=@image_saturation,image_blur=@image_blur,image_grayscale=@image_grayscale,frame_inset=@frame_inset,frame_width=@frame_width,frame_color=@frame_color,frame_opacity=@frame_opacity,frame_radius=@frame_radius,design_saved_at=NULL,render_status='DIRTY',updated_at=@updated_at WHERE id=@id AND project_id=@project_id`),",
    "assignAsset: db.prepare(`UPDATE slides SET selected_asset_id=?,render_status='DIRTY',updated_at=? WHERE id=?`),":
    "assignAsset: db.prepare(`UPDATE slides SET selected_asset_id=?,design_saved_at=NULL,render_status='DIRTY',updated_at=? WHERE id=?`),",
    "updateSlideContent: db.prepare(`UPDATE slides SET headline=@headline,body=@body,text_enabled=@text_enabled,overlay_text=@overlay_text,text_font=@text_font,text_size=@text_size,text_position=@text_position,text_color=@text_color,text_align=@text_align,text_x=@text_x,text_y=@text_y,text_layers=@text_layers,render_status='DIRTY',updated_at=@updated_at WHERE id=@id AND project_id=@project_id`),":
    "updateSlideContent: db.prepare(`UPDATE slides SET headline=@headline,body=@body,text_enabled=@text_enabled,overlay_text=@overlay_text,text_font=@text_font,text_size=@text_size,text_position=@text_position,text_color=@text_color,text_align=@text_align,text_x=@text_x,text_y=@text_y,text_layers=@text_layers,design_saved_at=NULL,render_status='DIRTY',updated_at=@updated_at WHERE id=@id AND project_id=@project_id`),",
    "approveSlideAsset: db.prepare(`UPDATE slides SET selected_asset_id=?,composition_mode=?,image_approved=1,render_status='DIRTY',updated_at=? WHERE id=?`),":
    "approveSlideAsset: db.prepare(`UPDATE slides SET selected_asset_id=?,composition_mode=?,image_approved=1,design_saved_at=NULL,render_status='DIRTY',updated_at=? WHERE id=?`),"
}
for before, after in replacements.items():
    if db.count(before) != 1:
        raise SystemExit(f'db sql anchor mismatch: {before[:32]}')
    db = db.replace(before, after, 1)
anchor = "  markSlideImagePending: db.prepare(`UPDATE slides SET image_approved=0 WHERE id=?`),"
insert = "  markSlideDesignSaved: db.prepare(`UPDATE slides SET design_saved_at=?,updated_at=? WHERE id=? AND project_id=?`),\n" + anchor
if db.count(anchor) != 1:
    raise SystemExit('db design saved statement anchor mismatch')
db = db.replace(anchor, insert, 1)
db_path.write_text(db)

# service-core.js: expose designSaved and add an atomic design-save operation that preserves prior approvals.
service_path = ROOT / 'src/service-core.js'
service = service_path.read_text()
old = '    textLayers: json(row.text_layers, []),\n    video: json(row.video_settings, {})'
new = '    textLayers: json(row.text_layers, []), designSaved: Boolean(row.design_saved_at), designSavedAt: row.design_saved_at || null,\n    video: json(row.video_settings, {})'
if service.count(old) != 1:
    raise SystemExit('service mapSlide anchor mismatch')
service = service.replace(old, new, 1)

clone_anchor = '        sql.updateSlideContent.run({ id: newSlideId, project_id: cloneId, headline: slide.headline, body: slide.body, text_enabled: slide.textEnabled ? 1 : 0, overlay_text: slide.overlayText, text_font: slide.textFont, text_size: slide.textSize, text_position: slide.textPosition, text_color: slide.textColor, text_align: slide.textAlign, text_x: slide.textX, text_y: slide.textY, text_layers: JSON.stringify(slide.textLayers || []), updated_at: timestamp });\n        sql.updateSlideVideo.run(JSON.stringify(slide.video || {}), timestamp, newSlideId, cloneId);'
clone_replacement = '        sql.updateSlideContent.run({ id: newSlideId, project_id: cloneId, headline: slide.headline, body: slide.body, text_enabled: slide.textEnabled ? 1 : 0, overlay_text: slide.overlayText, text_font: slide.textFont, text_size: slide.textSize, text_position: slide.textPosition, text_color: slide.textColor, text_align: slide.textAlign, text_x: slide.textX, text_y: slide.textY, text_layers: JSON.stringify(slide.textLayers || []), updated_at: timestamp });\n        if (slide.designSaved) sql.markSlideDesignSaved.run(timestamp, timestamp, newSlideId, cloneId);\n        sql.updateSlideVideo.run(JSON.stringify(slide.video || {}), timestamp, newSlideId, cloneId);'
if service.count(clone_anchor) != 1:
    raise SystemExit('service clone anchor mismatch')
service = service.replace(clone_anchor, clone_replacement, 1)

restore_anchor = '      sql.updateSlideContent.run({ id: oldSlide.id, project_id: projectId, headline: oldSlide.headline, body: oldSlide.body, text_enabled: oldSlide.textEnabled ? 1 : 0, overlay_text: oldSlide.overlayText, text_font: oldSlide.textFont, text_size: oldSlide.textSize, text_position: oldSlide.textPosition, text_color: oldSlide.textColor, text_align: oldSlide.textAlign, text_x: oldSlide.textX, text_y: oldSlide.textY, text_layers: JSON.stringify(oldSlide.textLayers || []), updated_at: timestamp });\n      sql.updateSlideVideo.run(JSON.stringify(oldSlide.video || {}), timestamp, oldSlide.id, projectId);'
restore_replacement = '      sql.updateSlideContent.run({ id: oldSlide.id, project_id: projectId, headline: oldSlide.headline, body: oldSlide.body, text_enabled: oldSlide.textEnabled ? 1 : 0, overlay_text: oldSlide.overlayText, text_font: oldSlide.textFont, text_size: oldSlide.textSize, text_position: oldSlide.textPosition, text_color: oldSlide.textColor, text_align: oldSlide.textAlign, text_x: oldSlide.textX, text_y: oldSlide.textY, text_layers: JSON.stringify(oldSlide.textLayers || []), updated_at: timestamp });\n      if (oldSlide.designSaved) sql.markSlideDesignSaved.run(timestamp, timestamp, oldSlide.id, projectId);\n      sql.updateSlideVideo.run(JSON.stringify(oldSlide.video || {}), timestamp, oldSlide.id, projectId);'
if service.count(restore_anchor) != 1:
    raise SystemExit('service restore anchor mismatch')
service = service.replace(restore_anchor, restore_replacement, 1)

function_anchor = 'export function getProjectVersions(projectId) {'
if service.count(function_anchor) != 1:
    raise SystemExit('service design function anchor mismatch')
design_function = '''export function updateSlideDesign(input) {
  const row = sql.getSlide.get(input.slideId);
  if (!row || row.project_id !== input.projectId) throw new AppError("SLIDE_NOT_FOUND", "Không tìm thấy slide.", 404);
  const project = requireProject(input.projectId), slide = mapSlide(row), timestamp = now();
  db.transaction(() => {
    sql.updateSlideCrop.run({
      id: input.slideId, project_id: input.projectId,
      crop_x: input.cropX ?? slide.cropX, crop_y: input.cropY ?? slide.cropY, crop_zoom: input.cropZoom ?? slide.cropZoom,
      image_brightness: input.imageBrightness ?? slide.imageBrightness, image_contrast: input.imageContrast ?? slide.imageContrast,
      image_saturation: input.imageSaturation ?? slide.imageSaturation, image_blur: input.imageBlur ?? slide.imageBlur,
      image_grayscale: input.imageGrayscale ?? slide.imageGrayscale, frame_inset: input.frameInset ?? slide.frameInset,
      frame_width: input.frameWidth ?? slide.frameWidth, frame_color: input.frameColor ?? slide.frameColor,
      frame_opacity: input.frameOpacity ?? slide.frameOpacity, frame_radius: input.frameRadius ?? slide.frameRadius,
      updated_at: timestamp
    });
    sql.updateSlideContent.run({
      id: input.slideId, project_id: input.projectId, headline: slide.headline, body: slide.body,
      text_enabled: input.textEnabled ?? slide.textEnabled ? 1 : 0,
      overlay_text: input.overlayText ?? slide.overlayText, text_font: input.textFont ?? slide.textFont,
      text_size: input.textSize ?? slide.textSize, text_position: input.textPosition ?? slide.textPosition,
      text_color: input.textColor ?? slide.textColor, text_align: input.textAlign ?? slide.textAlign,
      text_x: input.textX ?? slide.textX, text_y: input.textY ?? slide.textY,
      text_layers: JSON.stringify(input.textLayers ?? slide.textLayers ?? []), updated_at: timestamp
    });
    sql.markSlideDesignSaved.run(timestamp, timestamp, input.slideId, input.projectId);
    sql.updateProjectStatuses.run(project.content_status || "PENDING", project.image_status || "PENDING", timestamp, input.projectId);
    saveVersion(input.projectId, "save_slide_design");
  })();
  return getProject(input.projectId);
}

'''
service = service.replace(function_anchor, design_function + function_anchor, 1)
service_path.write_text(service)

# http-server.js: expose a dedicated endpoint for design saves.
http_path = ROOT / 'src/http-server.js'
http = http_path.read_text()
old_import = '  restoreProjectVersion, updateBrandKit, updateSlideCrop, updateSlideContent,\n  updateProjectVideo, updateSlideVideo'
new_import = '  restoreProjectVersion, updateBrandKit, updateSlideCrop, updateSlideContent, updateSlideDesign,\n  updateProjectVideo, updateSlideVideo'
if http.count(old_import) != 1:
    raise SystemExit('http import anchor mismatch')
http = http.replace(old_import, new_import, 1)
route_anchor = 'app.post("/api/projects/:projectId/slides/:slideId/assets/import-url", handle(async (req, res) => {'
if http.count(route_anchor) != 1:
    raise SystemExit('http design route anchor mismatch')
design_route = '''app.patch("/api/projects/:projectId/slides/:slideId/design", handle(async (req, res) => {
  const body = z.object({
    cropX: z.number().min(0).max(100), cropY: z.number().min(0).max(100), cropZoom: z.number().min(1).max(3),
    imageBrightness: z.number().min(.3).max(2).optional(), imageContrast: z.number().min(.3).max(2).optional(),
    imageSaturation: z.number().min(0).max(2).optional(), imageBlur: z.number().min(0).max(20).optional(),
    imageGrayscale: z.number().min(0).max(1).optional(), frameInset: z.number().int().min(0).max(360).optional(),
    frameWidth: z.number().int().min(0).max(80).optional(), frameColor: z.string().regex(/^#[0-9A-F]{6}$/iu).optional(),
    frameOpacity: z.number().min(0).max(1).optional(), frameRadius: z.number().int().min(0).max(240).optional(),
    textEnabled: z.boolean(), overlayText: z.string().max(500), textFont: z.string().min(1).max(100),
    textSize: z.number().min(24).max(220), textPosition: z.enum(["top", "center", "bottom"]),
    textColor: z.string().regex(/^#[0-9A-F]{6}$/iu), textAlign: z.enum(["left", "center", "right"]),
    textX: z.number().min(3).max(97), textY: z.number().min(3).max(97),
    textLayers: z.array(textLayerSchema).max(10).default([])
  }).parse(req.body);
  res.json(updateSlideDesign({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
}));

'''
http = http.replace(route_anchor, design_route + route_anchor, 1)
http_path.write_text(http)

# widget.js: render persisted design status and save through the dedicated endpoint.
widget_path = ROOT / 'public/widget.js'
widget = widget_path.read_text()
old_card = 'return `<article class="card" data-editor="${slide.id}">'
new_card = 'return `<article class="card" data-editor="${slide.id}" data-design-saved="${slide.designSaved ? "true" : "false"}">'
if widget.count(old_card) != 1:
    raise SystemExit('widget edit card anchor mismatch')
widget = widget.replace(old_card, new_card, 1)
start = widget.index('    if (event.target.closest(".save-design")) {')
end = widget.index('    }\n  } catch(error){alert(error.message);}', start) + len('    }')
old_block = widget[start:end]
new_block = '''    if (event.target.closest(".save-design")) {
      const primary = data.layers[0] || defaultLayer(slide);
      project = await json(`/api/projects/${projectId}/slides/${slideId}/design`, {
        method:"PATCH", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          cropX:data.cropX,cropY:data.cropY,cropZoom:data.cropZoom,
          imageBrightness:data.imageBrightness,imageContrast:data.imageContrast,imageSaturation:data.imageSaturation,
          imageBlur:data.imageBlur,imageGrayscale:data.imageGrayscale,frameInset:data.frameInset,frameWidth:data.frameWidth,
          frameColor:data.frameColor,frameOpacity:data.frameOpacity,frameRadius:data.frameRadius,
          textEnabled:true,overlayText:primary.content,textFont:primary.font,textSize:primary.size,textPosition:"center",
          textColor:primary.color,textAlign:primary.align,textX:primary.x,textY:primary.y,textLayers:data.layers
        })
      });
      drafts.delete(slideId); histories.delete(slideId); redos.delete(slideId); render();
    }'''
widget = widget[:start] + new_block + widget[end:]
widget_path.write_text(widget)

# stitch-ui.js: use the persisted flag for step-3 progress/inspector.
stitch_path = ROOT / 'public/stitch-ui.js'
stitch = stitch_path.read_text()
old_edit_status = "      status: 'pending',\n      image: q('.canvas-bg img', card)?.src || ''"
new_edit_status = "      status: card.dataset.designSaved === 'true' ? 'done' : 'pending',\n      image: q('.canvas-bg img', card)?.src || ''"
if stitch.count(old_edit_status) != 1:
    raise SystemExit('stitch edit status anchor mismatch')
stitch = stitch.replace(old_edit_status, new_edit_status, 1)
old_label = "    if (status === 'done') return view === 'images' ? 'Đã duyệt ảnh' : view === 'content' ? 'Đã duyệt nội dung' : 'Hoàn tất';"
new_label = "    if (status === 'done') return view === 'images' ? 'Đã duyệt ảnh' : view === 'content' ? 'Đã duyệt nội dung' : view === 'edit' ? 'Đã lưu thiết kế' : 'Hoàn tất';"
if stitch.count(old_label) != 1:
    raise SystemExit('stitch status label anchor mismatch')
stitch = stitch.replace(old_label, new_label, 1)
stitch_path.write_text(stitch)

# Regression tests: persistence, approval preservation and front-end wiring.
test_path = ROOT / 'src/design-save-status.test.js'
test_path.write_text('''import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-design-save-"));
process.env.DATABASE_PATH = path.join(tempDirectory, "design-save.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempDirectory, "assets");

const { db, sql } = await import(`./db.js?design-save=${Date.now()}`);
const service = await import(`./service-core.js?design-save=${Date.now()}`);

after(async () => {
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

test("saving slide design persists completion without resetting approvals", () => {
  const project = service.createProject({ title: "Design save" });
  const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Subject", headline: "Headline", body: "Body" });
  const timestamp = new Date().toISOString();
  sql.approveContent.run(timestamp, project.id);
  sql.approveImages.run(timestamp, project.id);
  db.prepare("UPDATE slides SET image_approved=1 WHERE id=?").run(slide.id);

  const saved = service.updateSlideDesign({
    projectId: project.id, slideId: slide.id,
    cropX: 50, cropY: 50, cropZoom: 1,
    imageBrightness: 1, imageContrast: 1, imageSaturation: 1, imageBlur: 0, imageGrayscale: 0,
    frameInset: 40, frameWidth: 0, frameColor: "#FFFFFF", frameOpacity: 1, frameRadius: 0,
    textEnabled: true, overlayText: "Headline", textFont: "TikTok Sans", textSize: 72,
    textPosition: "center", textColor: "#FFFFFF", textAlign: "center", textX: 50, textY: 80,
    textLayers: [{ id: "headline", role: "headline", content: "Headline", enabled: true, font: "TikTok Sans", size: 72, x: 50, y: 80, color: "#FFFFFF", align: "center", opacity: 1, rotation: 0 }]
  });

  assert.equal(saved.contentStatus, "APPROVED");
  assert.equal(saved.imageStatus, "APPROVED");
  assert.equal(saved.slides[0].imageApproved, true);
  assert.equal(saved.slides[0].designSaved, true);
  assert.ok(saved.slides[0].designSavedAt);

  const afterContentChange = service.updateSlideContent({
    projectId: project.id, slideId: slide.id, headline: "Headline", body: "Body changed",
    textEnabled: true, overlayText: "Headline", textFont: "TikTok Sans", textSize: 72,
    textPosition: "center", textColor: "#FFFFFF", textAlign: "center", textX: 50, textY: 80,
    textLayers: saved.slides[0].textLayers
  });
  assert.equal(afterContentChange.contentStatus, "PENDING");
  assert.equal(afterContentChange.slides[0].designSaved, false);
});

test("Carousel UI reads persisted design save state", async () => {
  const widget = await fs.readFile(new URL("../public/widget.js", import.meta.url), "utf8");
  const stitch = await fs.readFile(new URL("../public/stitch-ui.js", import.meta.url), "utf8");
  assert.match(widget, /data-design-saved=/u);
  assert.match(widget, /slides\/\$\{slideId\}\/design/u);
  assert.match(stitch, /card\.dataset\.designSaved === 'true' \? 'done' : 'pending'/u);
  assert.match(stitch, /Đã lưu thiết kế/u);
});
''')
