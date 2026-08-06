import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import {publicError} from "./errors.js";
import {registerCarouselTools} from "./mcp-tools-carousel.js";
import {
 VIDEO_CONTENT_DOMAINS,
 VIDEO_CONTENT_GOALS,
 VIDEO_SCRIPT_OPTION_IDS,
 VIDEO_TONE_STYLES,
 VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";
import {
 attachRemoteVideoSource,
 createVideoAnalysisProject,
 createVideoAnalysisProjectFromRemoteSource,
 getVideoAnalysisProject,
 getVideoAnalysisVersions,
 prepareVideoAnalysisScriptOptions,
 restoreVideoAnalysisVersion,
 savePreparedVideoAnalysisScript
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

function briefFromArgs(args){
 return{
  contentDomain:args.content_domain,
  contentGoal:args.content_goal,
  toneStyle:args.tone_style,
  ttsSpeed:args.tts_speed,
  customContentDomain:args.custom_content_domain,
  customContentGoal:args.custom_content_goal
 };
}

function registerVideoAnalysisTools(server){
 server.tool(
  "create_video_analysis_project",
  "Create an independent video analysis project only after collecting a content brief. If content_domain, tone_style, or tts_speed is missing from the conversation, ask the user one consolidated question and do not call this tool yet. Do not infer missing values. Remote source_url values are downloaded by Lana through an SSRF-protected importer and converted to a managed local asset before render. Video playback speed never changes. After analysis, call prepare_video_script_options with exactly two genuinely different options, show both in chat, and wait for explicit user selection before saving.",
  {
   title:z.string().min(1).max(200),source_url:z.string().url().optional(),source_filename:z.string().max(255).optional(),
   content_domain:z.enum(VIDEO_CONTENT_DOMAINS).describe("fashion, beauty, entertainment, food, travel, technology, education, business, lifestyle, or other"),
   content_goal:z.enum(VIDEO_CONTENT_GOALS).optional().describe("Optional: product_showcase, sales, review, tutorial, storytelling, entertainment, brand_awareness, engagement, or other"),
   tone_style:z.enum(VIDEO_TONE_STYLES).describe("humorous, witty, friendly, energetic, trendy, luxurious, serious, expert, emotional, storytelling, persuasive_sales, or minimal"),
   tts_speed:ttsSpeedSchema.describe("Voice speed only: 0.8, 1, 1.2, 1.5, 1.8, or 2. Video playback is unchanged."),
   custom_content_domain:z.string().max(200).optional(),custom_content_goal:z.string().max(200).optional()
  },
  async args=>{try{
   const input={
    title:args.title,
    sourceUrl:args.source_url,
    sourceFilename:args.source_filename,
    analysisBrief:briefFromArgs(args)
   };
   return ok(args.source_url
    ?await createVideoAnalysisProjectFromRemoteSource(input)
    :createVideoAnalysisProject(input));
  }catch(error){return fail(error)}}
 );

 server.tool("get_video_analysis_project","Get source reference, content brief, prepared options metadata, selected script option, approved script, settings, versions and direct studio link.",{project_id:z.string().uuid()},async args=>{try{return ok(getVideoAnalysisProject(args.project_id))}catch(error){return fail(error)}});
 server.tool(
  "attach_video_reference",
  "Import an HTTPS video reference through Lana's SSRF-protected downloader, store it as a managed local asset, and attach it to the project. Direct remote URLs are never passed to Remotion.",
  {project_id:z.string().uuid(),video_url:z.string().url(),filename:z.string().max(255).default("video.mp4"),mime_type:z.string().max(100).default("video/mp4"),duration:z.number().min(0).default(0)},
  async args=>{try{return ok(await attachRemoteVideoSource({projectId:args.project_id,url:args.video_url,filename:args.filename,duration:args.duration}))}catch(error){return fail(error)}}
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
  "Save only the option explicitly selected by the user from a previously persisted prepared_options_id. Do not send segments again: the server loads the exact validated option, verifies its hash and freshness, and records the selected option. Server-managed analysisBrief, TTS speed and selectedScriptOption cannot be overridden.",
  {
   project_id:z.string().uuid(),
   prepared_options_id:z.string().uuid(),
   selected_option:z.enum(VIDEO_SCRIPT_OPTION_IDS),
   approved:z.boolean().default(true),
   version_note:z.string().max(200).optional(),
   settings:editableVideoSettingsSchema.optional()
  },
  async args=>{try{return ok(savePreparedVideoAnalysisScript({
   projectId:args.project_id,
   preparedOptionsId:args.prepared_options_id,
   selectedOption:args.selected_option,
   approved:args.approved,
   note:args.version_note,
   settings:args.settings||{}
  }))}catch(error){return fail(error)}}
 );

 server.tool("list_video_analysis_versions","List immutable script/settings versions.",{project_id:z.string().uuid()},async args=>{try{return ok({versions:getVideoAnalysisVersions(args.project_id)})}catch(error){return fail(error)}});
 server.tool("restore_video_analysis_version","Restore a version and create a new version recording that restore.",{project_id:z.string().uuid(),version_id:z.string().uuid()},async args=>{try{return ok(restoreVideoAnalysisVersion(args.project_id,args.version_id))}catch(error){return fail(error)}});
 server.tool("start_video_analysis_render","Start optional subtitle + TTS render. Script must already be approved and the source must be a managed Lana asset.",{project_id:z.string().uuid()},async args=>{try{return ok(startVideoAnalysisJob(args.project_id))}catch(error){return fail(error)}});
 server.tool("get_video_analysis_job","Get render job progress and download URL.",{job_id:z.string().uuid()},async args=>{try{return ok(getVideoAnalysisJob(args.job_id))}catch(error){return fail(error)}});
 return server;
}

export function createMcpServer(){
 const server=new McpServer({name:"lana-carousel-standalone",version:"1.4.0"});
 registerCarouselTools(server);
 registerVideoAnalysisTools(server);
 return server;
}
