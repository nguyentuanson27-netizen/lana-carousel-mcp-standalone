import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import {AppError,publicError} from "./errors.js";
import {consumeApiQuota} from "./api-quota.js";
import {currentQuotaClientId,runWithQuotaPrincipal} from "./quota-principal.js";
import {createVideoAnalysisAccessUrl} from "./project-access.js";
import {registerCarouselTools} from "./mcp-tools-carousel.js";
import {
 VIDEO_CONTENT_DOMAINS,
 VIDEO_CONTENT_GOALS,
 VIDEO_SCRIPT_OPTION_IDS,
 VIDEO_TONE_STYLES,
 VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";
import {briefFromArgs as parseBriefFromArgs} from "./video-analysis-mcp-compat.js";
import {
 attachRemoteVideoSource,
 createVideoAnalysisProject,
 createVideoAnalysisProjectFromRemoteSource,
 getVideoAnalysisProject,
 getVideoAnalysisVersions,
 prepareVideoAnalysisScriptOptions,
 restoreVideoAnalysisVersion,
 savePreparedVideoAnalysisScript,
 saveVideoAnalysisScript
} from "./video-analysis-service.js";
import {getVideoAnalysisJob,startVideoAnalysisJob} from "./video-analysis-jobs.js";

const ok=value=>({content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value});
const fail=error=>{const safe=publicError(error);return{isError:true,content:[{type:"text",text:JSON.stringify(safe)}]}};
const ttsSpeedSchema=z.union(VIDEO_TTS_SPEEDS.map(value=>z.literal(value)));
const colorSchema=z.string().regex(/^#[0-9A-F]{6}$/iu);
const preparedSegmentSchema=z.object({
 id:z.string().min(1).max(100),start:z.number().min(0),end:z.number().positive(),
 subtitle_text:z.string().min(1).max(2000),voice_over_text:z.string().min(1).max(4000),
 speaker:z.enum(["speaker1","speaker2"]).default("speaker1"),enabled:z.boolean().default(true)
}).strict();
const legacyDraftSegmentSchema=z.object({
 id:z.string().min(1).max(100).optional(),start:z.number().min(0),end:z.number().positive(),
 subtitle_text:z.string().min(1).max(2000),voice_over_text:z.string().min(1).max(4000),
 speaker:z.enum(["speaker1","speaker2"]).default("speaker1"),enabled:z.boolean().default(true)
}).strict();
const editableVideoSettingsSchema=z.object({
 ttsEnabled:z.boolean().optional(),
 ttsProvider:z.enum(["vertex","gemini","google"]).optional(),
 ttsVolume:z.number().min(0).max(1).optional(),
 ttsVoice:z.string().min(1).max(100).optional(),
 originalAudioVolume:z.number().min(0).max(1).optional(),
 subtitleEnabled:z.boolean().optional(),
 subtitleFont:z.string().min(1).max(100).optional(),
 subtitleSize:z.number().min(20).max(96).optional(),
 subtitleColor:colorSchema.optional(),
 subtitleBackgroundColor:colorSchema.optional(),
 subtitleBackgroundOpacity:z.number().min(0).max(1).optional(),
 subtitleX:z.number().min(6).max(94).optional(),
 subtitlePosition:z.number().min(6).max(94).optional(),
 subtitleStyle:z.enum(["karaoke","word","static"]).optional(),
 geminiSpeaker1Voice:z.string().min(1).max(100).optional(),
 geminiSpeaker2Voice:z.string().min(1).max(100).optional(),
 geminiSpeaker1Name:z.string().min(1).max(100).optional(),
 geminiSpeaker2Name:z.string().min(1).max(100).optional(),
 geminiMultiSpeaker:z.boolean().optional(),
 geminiModel:z.string().min(1).max(150).optional()
}).strict();
const analysisBriefSettingsSchema=z.object({
 contentDomain:z.enum(VIDEO_CONTENT_DOMAINS),
 contentGoal:z.enum(VIDEO_CONTENT_GOALS).optional(),
 toneStyle:z.enum(VIDEO_TONE_STYLES),
 ttsSpeed:ttsSpeedSchema,
 customContentDomain:z.string().max(200).optional(),
 customContentGoal:z.string().max(200).optional()
}).strict();
const legacyDraftSettingsSchema=editableVideoSettingsSchema.extend({
 analysisBrief:analysisBriefSettingsSchema.optional(),
 selectedScriptOption:z.enum(VIDEO_SCRIPT_OPTION_IDS).optional()
}).strict();

const readOnlyTools=new Set([
 "list_projects",
 "get_render_status",
 "list_project_versions",
 "list_video_analysis_versions",
 "get_video_analysis_job"
]);

const alwaysHeavyTools=new Set([
 "import_asset_from_url",
 "add_image_candidate",
 "add_image_candidates",
 "render_project",
 "clone_project",
 "attach_video_reference",
 "start_video_analysis_render"
]);

export function quotaPolicyForTool(name,args={}){
 const mutations=readOnlyTools.has(name)?0:1;
 let heavy=alwaysHeavyTools.has(name)?1:0;
 if(name==="create_video_analysis_project"&&args.source_url)heavy=1;
 return{mutations,heavy};
}

function installToolQuota(server,clientId){
 const originalTool=server.tool.bind(server);
 server.tool=(name,...definition)=>{
  const index=definition.length-1;
  const handler=definition[index];
  if(typeof handler==="function"){
   definition[index]=async(...handlerArgs)=>{
    try{
     const policy=quotaPolicyForTool(name,handlerArgs[0]||{});
     consumeApiQuota(clientId,policy);
     return await runWithQuotaPrincipal(clientId,()=>handler(...handlerArgs));
    }catch(error){
     return fail(error);
    }
   };
  }
  return originalTool(name,...definition);
 };
 return server;
}

function briefFromArgs(args){return parseBriefFromArgs(args)}

function withStudioAccess(project){
 return{
  ...project,
  studioUrl:createVideoAnalysisAccessUrl(project.id)
 };
}

function legacyDraftSave(args){
 if(args.approved!==false){
  throw new AppError(
   "VIDEO_LEGACY_DRAFT_ONLY",
   "Payload segments kiểu cũ chỉ được lưu dưới dạng bản nháp. Hãy dùng prepared_options_id để duyệt script.",
   422
  );
 }
 const project=getVideoAnalysisProject(args.project_id);
 const legacySettings=args.settings||{};
 const analysisBrief=legacySettings.analysisBrief||project.analysisBrief;
 if(!analysisBrief){
  throw new AppError(
   "VIDEO_ANALYSIS_BRIEF_REQUIRED",
   "Payload schema cũ phải gửi settings.analysisBrief trước khi lưu bản nháp.",
   422
  );
 }
 if(!legacySettings.selectedScriptOption){
  throw new AppError(
   "VIDEO_SCRIPT_OPTION_REQUIRED",
   "Payload schema cũ phải gửi settings.selectedScriptOption.",
   422
  );
 }
 const{
  analysisBrief:_analysisBrief,
  selectedScriptOption,
  ...editableSettings
 }=legacySettings;
 return saveVideoAnalysisScript({
  projectId:args.project_id,
  script:{
   summary:args.summary||"",
   segments:args.segments.map(segment=>({
    id:segment.id,
    start:segment.start,
    end:segment.end,
    subtitleText:segment.subtitle_text,
    voiceOverText:segment.voice_over_text,
    speaker:segment.speaker,
    enabled:segment.enabled
   }))
  },
  settings:editableSettings,
  managedSettings:{
   analysisBrief,
   selectedScriptOption,
   preparedScriptOptions:null
  },
  approved:false,
  note:args.version_note
 });
}

function registerVideoAnalysisTools(server){
 server.tool(
  "create_video_analysis_project",
  "Create an independent video analysis project only after collecting a content brief. New clients must send content_domain, tone_style and tts_speed. For a temporary stale-schema compatibility window, a request with every brief field omitted creates an unconfigured draft; the legacy draft save path must then provide settings.analysisBrief. Any partial brief, including optional-only brief fields, is rejected. Remote source_url values are downloaded by Lana through an SSRF-protected importer and converted to a managed local asset before render. Video playback speed never changes. After analysis, call prepare_video_script_options with exactly two genuinely different options, show both in chat, and wait for explicit user selection before saving.",
  {
   title:z.string().min(1).max(200),source_url:z.string().url().optional(),source_filename:z.string().max(255).optional(),
   content_domain:z.enum(VIDEO_CONTENT_DOMAINS).optional().describe("Required for current clients: fashion, beauty, entertainment, food, travel, technology, education, business, lifestyle, or other"),
   content_goal:z.enum(VIDEO_CONTENT_GOALS).optional().describe("Optional: product_showcase, sales, review, tutorial, storytelling, entertainment, brand_awareness, engagement, or other"),
   tone_style:z.enum(VIDEO_TONE_STYLES).optional().describe("Required for current clients: humorous, witty, friendly, energetic, trendy, luxurious, serious, expert, emotional, storytelling, persuasive_sales, or minimal"),
   tts_speed:ttsSpeedSchema.optional().describe("Required for current clients. Voice speed only: 0.8, 1, 1.2, 1.5, 1.8, or 2. Video playback is unchanged."),
   custom_content_domain:z.string().max(200).optional(),custom_content_goal:z.string().max(200).optional()
  },
  async args=>{try{
   const input={
    title:args.title,
    sourceUrl:args.source_url,
    sourceFilename:args.source_filename,
    analysisBrief:briefFromArgs(args)
   };
   const project=args.source_url
    ?await createVideoAnalysisProjectFromRemoteSource(input)
    :createVideoAnalysisProject(input);
   return ok(withStudioAccess(project));
  }catch(error){return fail(error)}}
 );

 server.tool("get_video_analysis_project","Get source reference, content brief, prepared options metadata, selected script option, approved script, settings, versions and a one-time direct studio link.",{project_id:z.string().uuid()},async args=>{try{return ok(withStudioAccess(getVideoAnalysisProject(args.project_id)))}catch(error){return fail(error)}});
 server.tool(
  "attach_video_reference",
  "Import an HTTPS video reference through Lana's SSRF-protected downloader, store it as a managed local asset, and attach it to the project. Direct remote URLs are never passed to Remotion.",
  {project_id:z.string().uuid(),video_url:z.string().url(),filename:z.string().max(255).default("video.mp4"),mime_type:z.string().max(100).default("video/mp4"),duration:z.number().min(0).default(0)},
  async args=>{try{return ok(withStudioAccess(await attachRemoteVideoSource({projectId:args.project_id,url:args.video_url,filename:args.filename,duration:args.duration})))}catch(error){return fail(error)}}
 );

 server.tool(
  "prepare_video_script_options",
  "Validate and persist exactly two subtitle/voice-over options. Both options must contain at least one enabled segment, use the same ordered segment ids, timestamps and enabled flags, and be materially different on enabled segments. natural_full uses complete natural sentences; punchy_short must be shorter and rhythmic. Return prepared_options_id, show both options and fit warnings, then wait for explicit user selection.",
  {
   project_id:z.string().uuid(),summary:z.string().max(5000).default(""),
   options:z.array(z.object({
    option_id:z.enum(VIDEO_SCRIPT_OPTION_IDS),label:z.string().min(1).max(200),
    segments:z.array(preparedSegmentSchema).min(1).max(500)
   }).strict()).length(2)
  },
  async args=>{try{return ok(prepareVideoAnalysisScriptOptions({
   projectId:args.project_id,
   summary:args.summary,
   options:args.options.map(option=>({
    optionId:option.option_id,
    label:option.label,
    segments:option.segments.map(segment=>({
     id:segment.id,start:segment.start,end:segment.end,
     subtitleText:segment.subtitle_text,voiceOverText:segment.voice_over_text,
     speaker:segment.speaker,enabled:segment.enabled
    }))
   }))
  }))}catch(error){return fail(error)}}
 );

 server.tool(
  "save_approved_video_script",
  "Current clients must save the explicitly selected persisted option with prepared_options_id and selected_option. During the stale-schema compatibility window, legacy segments are accepted only when approved=false and settings contains both analysisBrief and selectedScriptOption; this path can never approve or render content.",
  {
   project_id:z.string().uuid(),
   prepared_options_id:z.string().uuid().optional(),
   selected_option:z.enum(VIDEO_SCRIPT_OPTION_IDS).optional(),
   summary:z.string().max(5000).default(""),
   segments:z.array(legacyDraftSegmentSchema).min(1).max(500).optional(),
   approved:z.boolean().default(true),
   version_note:z.string().max(200).optional(),
   settings:legacyDraftSettingsSchema.optional()
  },
  async args=>{try{
   const hasPrepared=Boolean(args.prepared_options_id||args.selected_option);
   const hasLegacy=Array.isArray(args.segments);
   if(hasPrepared&&hasLegacy){
    throw new AppError(
     "VIDEO_SCRIPT_SAVE_MODE_CONFLICT",
     "Không được gửi đồng thời prepared option và legacy segments.",
     422
    );
   }
   if(hasPrepared){
    if(!args.prepared_options_id||!args.selected_option){
     throw new AppError(
      "VIDEO_SCRIPT_SELECTION_INCOMPLETE",
      "prepared_options_id và selected_option phải được gửi cùng nhau.",
      422
     );
    }
    const{
     analysisBrief,
     selectedScriptOption,
     ...editableSettings
    }=args.settings||{};
    if(analysisBrief||selectedScriptOption){
     throw new AppError(
      "VIDEO_MANAGED_SETTINGS_OVERRIDE",
      "Không thể ghi đè analysisBrief hoặc selectedScriptOption trong prepared option flow.",
      422
     );
    }
    return ok(withStudioAccess(savePreparedVideoAnalysisScript({
     projectId:args.project_id,
     preparedOptionsId:args.prepared_options_id,
     selectedOption:args.selected_option,
     approved:args.approved,
     note:args.version_note,
     settings:editableSettings
    })));
   }
   if(!hasLegacy){
    throw new AppError(
     "VIDEO_SCRIPT_SAVE_MODE_REQUIRED",
     "Hãy gửi prepared_options_id + selected_option, hoặc legacy segments cho bản nháp.",
     422
    );
   }
   return ok(withStudioAccess(legacyDraftSave(args)));
  }catch(error){return fail(error)}}
 );

 server.tool("list_video_analysis_versions","List immutable script/settings versions.",{project_id:z.string().uuid()},async args=>{try{return ok({versions:getVideoAnalysisVersions(args.project_id)})}catch(error){return fail(error)}});
 server.tool("restore_video_analysis_version","Restore a version and create a new version recording that restore.",{project_id:z.string().uuid(),version_id:z.string().uuid()},async args=>{try{return ok(withStudioAccess(restoreVideoAnalysisVersion(args.project_id,args.version_id)))}catch(error){return fail(error)}});
 server.tool("start_video_analysis_render","Start optional subtitle + TTS render. Script must already be approved and the source must be a managed Lana asset.",{project_id:z.string().uuid()},async args=>{try{return ok(startVideoAnalysisJob(args.project_id))}catch(error){return fail(error)}});
 server.tool("get_video_analysis_job","Get render job progress and download URL.",{job_id:z.string().uuid()},async args=>{try{return ok(getVideoAnalysisJob(args.job_id))}catch(error){return fail(error)}});
 return server;
}

export function createMcpServer({quotaClientId=currentQuotaClientId()}={}){
 const server=installToolQuota(new McpServer({name:"lana-carousel-standalone",version:"1.7.0"}),quotaClientId);
 registerCarouselTools(server);
 registerVideoAnalysisTools(server);
 return server;
}
