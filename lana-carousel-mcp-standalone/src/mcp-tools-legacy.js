import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicError } from "./errors.js";
import {
  addSlide, approveProjectContent, approveSlideAssets, cloneProject, createProject, deleteProject,
  extendProject, getProject, getProjectVersions, importAssetFromUrl, listProjects, restoreProjectVersion, updateBrandKit,
  updateSlideContent, updateSlideCrop
} from "./service.js";
import { getRenderJob, startRenderJob } from "./render-jobs.js";
import {attachVideoSource,createVideoAnalysisProject,getVideoAnalysisProject,getVideoAnalysisVersions,restoreVideoAnalysisVersion,saveVideoAnalysisScript} from "./video-analysis-service.js";
import {getVideoAnalysisJob,startVideoAnalysisJob} from "./video-analysis-jobs.js";

function ok(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function fail(error) {
  const safe = publicError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(safe) }]
  };
}

export function createMcpServer() {
  const server = new McpServer({
    name: "lana-carousel-standalone",
    version: "1.3.0"
  });

  server.tool("create_project", "Create one carousel project that automatically expires and is permanently deleted after 14 days. Decide content slides first. Create exactly one slide per content subject; image alternatives are never slides and must use add_image_candidate.", {
    title: z.string().min(1).max(200),
    topic: z.string().max(500).optional(),
    slide_limit: z.number().int().min(1).max(20).default(10)
  }, async (args) => {
    try { return ok(createProject({ title: args.title, topic: args.topic, slideLimit: args.slide_limit })); } catch (error) { return fail(error); }
  });

  server.tool("add_slide", "Add one CONTENT slide for one unique subject. NEVER create slides named Image/Ảnh 1/8, 2/8, etc. Attach multiple image choices by calling add_image_candidate with this same slide_id, maximum 10 candidates.", {
    project_id: z.string().uuid(),
    position: z.number().int().positive(),
    subject: z.string().min(1),
    headline: z.string().min(1),
    body: z.string().min(1)
  }, async (args) => {
    try {
      return ok(addSlide({
        projectId: args.project_id,
        position: args.position,
        subject: args.subject,
        headline: args.headline,
        body: args.body
      }));
    } catch (error) { return fail(error); }
  });

  server.tool("get_project", "Get a project with slides, image assets, and widgetUrl. Always share widgetUrl as a clickable link in the chat so the user can open the project directly.", {
    project_id: z.string().uuid()
  }, async (args) => {
    try { return ok(getProject(args.project_id)); } catch (error) { return fail(error); }
  });

  server.tool("get_project_link", "Get the direct clickable widget link for a project. After creating or updating a project, call this tool and send widgetUrl directly in the chat.", {
    project_id: z.string().uuid()
  }, async (args) => {
    try {
      const project = getProject(args.project_id);
      return ok({ projectId: project.id, title: project.title, widgetUrl: project.widgetUrl, expiresAt: project.expiresAt });
    } catch (error) { return fail(error); }
  });

  server.tool(
    "import_asset_from_url",
    "Assign one final image directly to an existing content slide. Do not use this for image alternatives; use add_image_candidate or add_image_candidates instead. Never create another slide for another image.",
    {
      project_id: z.string().uuid(),
      slide_id: z.string().uuid(),
      image_url: z.string().url(),
      source_page_url: z.string().url().optional(),
      source_title: z.string().max(500).optional(),
      source_publisher: z.string().max(200).optional(),
      source_type: z.enum(["official_brand", "official_social", "news", "magazine", "unknown"]).optional(),
      alt_text: z.string().max(500).optional(),
      force_replace: z.boolean().optional()
    },
    async (args) => {
      try {
        return ok(await importAssetFromUrl({
          projectId: args.project_id,
          slideId: args.slide_id,
          imageUrl: args.image_url,
          sourcePageUrl: args.source_page_url,
          sourceTitle: args.source_title,
          sourcePublisher: args.source_publisher,
          sourceType: args.source_type,
          altText: args.alt_text,
          forceReplace: args.force_replace || false
        }));
      } catch (error) { return fail(error); }
    }
  );

  server.tool(
    "add_image_candidate",
    "Add ONE candidate to an EXISTING content slide without creating a new slide. Reuse the same slide_id for all alternatives. Maximum 10 candidates per slide; never represent candidates as separate slides.",
    {
      project_id: z.string().uuid(),
      slide_id: z.string().uuid(),
      image_url: z.string().url(),
      source_page_url: z.string().url().optional(),
      source_title: z.string().max(500).optional(),
      source_publisher: z.string().max(200).optional(),
      source_type: z.enum(["official_brand", "official_social", "news", "magazine", "unknown"]).optional(),
      alt_text: z.string().max(500).optional()
    },
    async (args) => {
      try {
        return ok(await importAssetFromUrl({
          projectId: args.project_id,
          slideId: args.slide_id,
          imageUrl: args.image_url,
          sourcePageUrl: args.source_page_url,
          sourceTitle: args.source_title,
          sourcePublisher: args.source_publisher,
          sourceType: args.source_type,
          altText: args.alt_text,
          selectAsset: false
        }));
      } catch (error) { return fail(error); }
    }
  );

  server.tool(
    "add_image_candidates",
    "Preferred batch tool: add 1–10 image candidates to ONE existing content slide. This is the correct tool for 3–10 alternatives. Do not call add_slide for individual images.",
    {
      project_id: z.string().uuid(),
      slide_id: z.string().uuid(),
      images: z.array(z.object({
        image_url: z.string().url(),
        source_page_url: z.string().url().optional(),
        source_title: z.string().max(500).optional(),
        source_publisher: z.string().max(200).optional(),
        source_type: z.enum(["official_brand", "official_social", "news", "magazine", "unknown"]).optional(),
        alt_text: z.string().max(500).optional()
      })).min(1).max(10)
    },
    async (args) => {
      const results = [], failures = [];
      for (const [index, image] of args.images.entries()) {
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const asset = await importAssetFromUrl({
              projectId: args.project_id, slideId: args.slide_id,
              imageUrl: image.image_url, sourcePageUrl: image.source_page_url,
              sourceTitle: image.source_title, sourcePublisher: image.source_publisher,
              sourceType: image.source_type, altText: image.alt_text, selectAsset: false
            });
            results.push({ index, attempts: attempt, asset });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (lastError) failures.push({ index, imageUrl: image.image_url, attempts: 2, error: lastError.message });
      }
      return ok({ success: failures.length === 0, partialSuccess: results.length > 0 && failures.length > 0,
        projectId: args.project_id, slideId: args.slide_id, requested: args.images.length,
        added: results.length, failed: failures.length, results, failures });
    }
  );

  server.tool("list_projects", "List active projects, optionally filtered by title/topic.", {
    search: z.string().max(200).optional()
  }, async (args) => { try { return ok({ projects: listProjects({ search: args.search || "" }) }); } catch (error) { return fail(error); } });

  server.tool("update_slide_content", "Update the editable headline and body of one slide.", {
    project_id: z.string().uuid(), slide_id: z.string().uuid(), headline: z.string().min(1).max(300), body: z.string().min(1).max(2000)
  }, async (args) => {
    try {
      const slide = getProject(args.project_id).slides.find(item => item.id === args.slide_id);
      if (!slide) throw new Error("Slide not found");
      return ok(updateSlideContent({ projectId: args.project_id, slideId: args.slide_id, headline: args.headline, body: args.body,
        textEnabled: slide.textEnabled, overlayText: slide.overlayText, textFont: slide.textFont, textSize: slide.textSize,
        textPosition: slide.textPosition, textColor: slide.textColor, textAlign: slide.textAlign,
        textX: slide.textX, textY: slide.textY, textLayers: slide.textLayers }));
    } catch (error) { return fail(error); }
  });

  server.tool("update_slide_design", "Update crop focal point/zoom and primary text style for one slide.", {
    project_id: z.string().uuid(), slide_id: z.string().uuid(), crop_x: z.number().min(0).max(100).optional(),
    crop_y: z.number().min(0).max(100).optional(), crop_zoom: z.number().min(1).max(3).optional(),
    text: z.string().max(500).optional(), font: z.string().max(100).optional(), size: z.number().min(24).max(220).optional(),
    color: z.string().regex(/^#[0-9A-F]{6}$/i).optional(), x: z.number().min(3).max(97).optional(), y: z.number().min(3).max(97).optional()
  }, async (args) => {
    try {
      let project = getProject(args.project_id); const slide = project.slides.find(item => item.id === args.slide_id);
      if (!slide) throw new Error("Slide not found");
      if (args.crop_x !== undefined || args.crop_y !== undefined || args.crop_zoom !== undefined) project = updateSlideCrop({ projectId: args.project_id, slideId: args.slide_id, cropX: args.crop_x ?? slide.cropX, cropY: args.crop_y ?? slide.cropY, cropZoom: args.crop_zoom ?? slide.cropZoom });
      const current = project.slides.find(item => item.id === args.slide_id);
      return ok(updateSlideContent({ projectId: args.project_id, slideId: args.slide_id, headline: current.headline, body: current.body,
        textEnabled: true, overlayText: args.text ?? current.overlayText, textFont: args.font ?? current.textFont,
        textSize: args.size ?? current.textSize, textPosition: "center", textColor: args.color ?? current.textColor,
        textAlign: current.textAlign, textX: args.x ?? current.textX, textY: args.y ?? current.textY, textLayers: current.textLayers }));
    } catch (error) { return fail(error); }
  });

  server.tool("approve_content", "Approve all project content so image review can proceed.", { project_id: z.string().uuid() },
    async args => { try { return ok(approveProjectContent(args.project_id)); } catch (error) { return fail(error); } });

  server.tool("approve_slide_images", "Approve 1–10 candidate assets for a slide as crop or grid.", {
    project_id: z.string().uuid(), slide_id: z.string().uuid(), asset_ids: z.array(z.string().uuid()).min(1).max(10), mode: z.enum(["crop", "grid"])
  }, async args => { try { return ok(approveSlideAssets({ projectId: args.project_id, slideId: args.slide_id, assetIds: args.asset_ids, mode: args.mode })); } catch (error) { return fail(error); } });

  server.tool("update_brand_kit", "Save project font/color and optionally apply them to every slide.", {
    project_id: z.string().uuid(), font: z.string().min(1).max(100), color: z.string().regex(/^#[0-9A-F]{6}$/i), apply_to_all: z.boolean().default(true)
  }, async args => { try { return ok(updateBrandKit({ projectId: args.project_id, font: args.font, color: args.color, applyToAll: args.apply_to_all })); } catch (error) { return fail(error); } });

  server.tool("render_project", "Start background rendering. Poll get_render_status until READY, then share downloadUrl.", { project_id: z.string().uuid() },
    async args => { try { getProject(args.project_id); return ok(startRenderJob(args.project_id)); } catch (error) { return fail(error); } });

  server.tool("get_render_status", "Get background render progress and final downloadUrl.", { job_id: z.string().uuid() },
    async args => { try { return ok(getRenderJob(args.job_id)); } catch (error) { return fail(error); } });

  server.tool("extend_project", "Extend a project's expiry by 1–90 days.", { project_id: z.string().uuid(), days: z.number().int().min(1).max(90).default(14) },
    async args => { try { return ok(extendProject(args.project_id, args.days)); } catch (error) { return fail(error); } });

  server.tool("delete_project", "Permanently delete one internal project and its stored asset files. Use only when explicitly requested.", { project_id: z.string().uuid() },
    async args => { try { return ok(await deleteProject(args.project_id)); } catch (error) { return fail(error); } });

  server.tool("clone_project", "Clone a project with its slides, assets, approvals and design into a new 14-day project.", { project_id: z.string().uuid() },
    async args => { try { return ok(await cloneProject(args.project_id)); } catch (error) { return fail(error); } });

  server.tool("restore_project_version", "Restore slide content/design and approval statuses from a version id returned by the versions API.", {
    project_id: z.string().uuid(), version_id: z.string().uuid()
  }, async args => { try { return ok(restoreProjectVersion(args.project_id, args.version_id)); } catch (error) { return fail(error); } });

  server.tool("list_project_versions", "List up to 50 saved versions for rollback.", { project_id: z.string().uuid() },
    async args => { try { return ok({ versions: getProjectVersions(args.project_id) }); } catch (error) { return fail(error); } });

  server.tool("create_video_analysis_project","Create an independent video analysis project. ChatGPT analyzes the video and only hands approved structured script to Lana. Return studioUrl to the user.",{title:z.string().min(1).max(200),source_url:z.string().url().optional(),source_filename:z.string().max(255).optional()},async a=>{try{return ok(createVideoAnalysisProject({title:a.title,sourceUrl:a.source_url,sourceFilename:a.source_filename}))}catch(e){return fail(e)}});
  server.tool("get_video_analysis_project","Get source reference, approved script, settings, versions and direct studio link.",{project_id:z.string().uuid()},async a=>{try{return ok(getVideoAnalysisProject(a.project_id))}catch(e){return fail(e)}});
  server.tool("attach_video_reference","Attach an HTTPS video file reference supplied by ChatGPT or a previously uploaded Lana asset.",{project_id:z.string().uuid(),video_url:z.string().url(),filename:z.string().max(255).default("video.mp4"),mime_type:z.string().max(100).default("video/mp4"),duration:z.number().min(0).default(0)},async a=>{try{return ok(attachVideoSource({projectId:a.project_id,url:a.video_url,filename:a.filename,mime:a.mime_type,duration:a.duration}))}catch(e){return fail(e)}});
  server.tool("save_approved_video_script","Save a draft or approved voice-over/subtitle script as a new immutable version. Rendering is optional.",{project_id:z.string().uuid(),approved:z.boolean().default(true),version_note:z.string().max(200).optional(),summary:z.string().max(5000).default(""),segments:z.array(z.object({id:z.string().optional(),start:z.number().min(0),end:z.number().positive(),subtitle_text:z.string().max(2000),voice_over_text:z.string().max(4000),speaker:z.enum(["speaker1","speaker2"]).default("speaker1"),enabled:z.boolean().default(true)})).max(500),settings:z.record(z.any()).optional()},async a=>{try{return ok(saveVideoAnalysisScript({projectId:a.project_id,approved:a.approved,note:a.version_note,script:{summary:a.summary,language:"vi-VN",segments:a.segments.map(s=>({id:s.id,start:s.start,end:s.end,subtitleText:s.subtitle_text,voiceOverText:s.voice_over_text,speaker:s.speaker,enabled:s.enabled}))},settings:a.settings||{}}))}catch(e){return fail(e)}});
  server.tool("list_video_analysis_versions","List immutable script/settings versions.",{project_id:z.string().uuid()},async a=>{try{return ok({versions:getVideoAnalysisVersions(a.project_id)})}catch(e){return fail(e)}});
  server.tool("restore_video_analysis_version","Restore a version and create a new version recording that restore.",{project_id:z.string().uuid(),version_id:z.string().uuid()},async a=>{try{return ok(restoreVideoAnalysisVersion(a.project_id,a.version_id))}catch(e){return fail(e)}});
  server.tool("start_video_analysis_render","Start optional subtitle + TTS render. Script must already be approved.",{project_id:z.string().uuid()},async a=>{try{return ok(startVideoAnalysisJob(a.project_id))}catch(e){return fail(e)}});
  server.tool("get_video_analysis_job","Get render job progress and download URL.",{job_id:z.string().uuid()},async a=>{try{return ok(getVideoAnalysisJob(a.job_id))}catch(e){return fail(e)}});
  return server;
}
