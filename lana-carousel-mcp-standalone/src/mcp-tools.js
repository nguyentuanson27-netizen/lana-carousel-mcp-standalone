import {z} from "zod";
import {publicError} from "./errors.js";
import {createMcpServer as createLegacyMcpServer} from "./mcp-tools-legacy.js";
import {
  evaluateVideoScriptOptions,
  VIDEO_CONTENT_DOMAINS,
  VIDEO_CONTENT_GOALS,
  VIDEO_SCRIPT_OPTION_IDS,
  VIDEO_TONE_STYLES,
  VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";
import {
  attachVideoSource,
  createVideoAnalysisProject,
  getVideoAnalysisProject,
  getVideoAnalysisVersions,
  restoreVideoAnalysisVersion,
  saveVideoAnalysisScript
} from "./video-analysis-service.js";
import {getVideoAnalysisJob,startVideoAnalysisJob} from "./video-analysis-jobs.js";

const ok=value=>({content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value});
const fail=error=>{const safe=publicError(error);return{isError:true,content:[{type:"text",text:JSON.stringify(safe)}]}};
const ttsSpeedSchema=z.union(VIDEO_TTS_SPEEDS.map(value=>z.literal(value)));
const segmentSchema=z.object({
  id:z.string().optional(),start:z.number().min(0),end:z.number().positive(),
  subtitle_text:z.string().max(2000),voice_over_text:z.string().max(4000),
  speaker:z.enum(["speaker1","speaker2"]).default("speaker1"),enabled:z.boolean().default(true)
});
const legacyVideoTools=[
  "create_video_analysis_project","get_video_analysis_project","attach_video_reference",
  "save_approved_video_script","list_video_analysis_versions","restore_video_analysis_version",
  "start_video_analysis_render","get_video_analysis_job"
];

function removeLegacyVideoTools(server){
  const tools=Reflect.get(server,"_registeredTools");
  if(!(tools instanceof Map))throw new Error("MCP SDK does not expose the expected registered tool map.");
  for(const name of legacyVideoTools)tools.delete(name);
}

export function createMcpServer(){
  const server=createLegacyMcpServer();
  removeLegacyVideoTools(server);

  server.tool(
    "create_video_analysis_project",
    "Create an independent video analysis project only after collecting a content brief. If content_domain, tone_style, or tts_speed is missing from the conversation, ask the user one consolidated question and do not call this tool yet. Do not infer missing values. Suggested compact reply: 'Thời trang – Hài hước – x1.2 – Giới thiệu sản phẩm'. Video playback speed never changes. After analysis, call prepare_video_script_options with exactly two genuinely different options, show both in chat, and wait for explicit user selection before saving.",
    {
      title:z.string().min(1).max(200),source_url:z.string().url().optional(),source_filename:z.string().max(255).optional(),
      content_domain:z.enum(VIDEO_CONTENT_DOMAINS).describe("fashion, beauty, entertainment, food, travel, technology, education, business, lifestyle, or other"),
      content_goal:z.enum(VIDEO_CONTENT_GOALS).optional().describe("Optional: product_showcase, sales, review, tutorial, storytelling, entertainment, brand_awareness, engagement, or other"),
      tone_style:z.enum(VIDEO_TONE_STYLES).describe("humorous, witty, friendly, energetic, trendy, luxurious, serious, expert, emotional, storytelling, persuasive_sales, or minimal"),
      tts_speed:ttsSpeedSchema.describe("Voice speed only: 0.8, 1, 1.2, 1.5, 1.8, or 2. Video playback is unchanged."),
      custom_content_domain:z.string().max(200).optional(),custom_content_goal:z.string().max(200).optional()
    },
    async args=>{try{return ok(createVideoAnalysisProject({
      title:args.title,sourceUrl:args.source_url,sourceFilename:args.source_filename,
      analysisBrief:{contentDomain:args.content_domain,contentGoal:args.content_goal,toneStyle:args.tone_style,ttsSpeed:args.tts_speed,customContentDomain:args.custom_content_domain,customContentGoal:args.custom_content_goal}
    }))}catch(error){return fail(error)}}
  );

  server.tool("get_video_analysis_project","Get source reference, content brief, selected script option, approved script, settings, versions and direct studio link.",{project_id:z.string().uuid()},async args=>{try{return ok(getVideoAnalysisProject(args.project_id))}catch(error){return fail(error)}});
  server.tool("attach_video_reference","Attach an HTTPS video file reference supplied by ChatGPT or a previously uploaded Lana asset.",{project_id:z.string().uuid(),video_url:z.string().url(),filename:z.string().max(255).default("video.mp4"),mime_type:z.string().max(100).default("video/mp4"),duration:z.number().min(0).default(0)},async args=>{try{return ok(attachVideoSource({projectId:args.project_id,url:args.video_url,filename:args.filename,mime:args.mime_type,duration:args.duration}))}catch(error){return fail(error)}});

  server.tool(
    "prepare_video_script_options",
    "Validate exactly two subtitle/voice-over options before presenting them. natural_full uses complete natural sentences and targets 80–90% of the safe word budget. punchy_short must be structurally different, short and rhythmic, targeting 55–70%. Budgets use each segment duration and the selected project TTS speed. Show both options and fit warnings, then wait for explicit user selection. Do not save either option yet.",
    {
      project_id:z.string().uuid(),summary:z.string().max(5000).default(""),
      options:z.array(z.object({
        option_id:z.enum(VIDEO_SCRIPT_OPTION_IDS),label:z.string().min(1).max(200),
        segments:z.array(segmentSchema.pick({id:true,start:true,end:true,subtitle_text:true,voice_over_text:true})).max(500)
      })).length(2)
    },
    async args=>{try{
      const project=getVideoAnalysisProject(args.project_id);
      const evaluated=evaluateVideoScriptOptions({brief:project.settings.analysisBrief,options:args.options.map(option=>({optionId:option.option_id,label:option.label,segments:option.segments.map(segment=>({id:segment.id,start:segment.start,end:segment.end,subtitleText:segment.subtitle_text,voiceOverText:segment.voice_over_text}))}))});
      return ok({projectId:project.id,summary:args.summary,...evaluated});
    }catch(error){return fail(error)}}
  );

  server.tool(
    "save_approved_video_script",
    "Save only the script option explicitly selected by the user after both prepared options were shown. Never choose on the user's behalf. selected_option is required. The project brief TTS speed is applied automatically and the selected option is recorded in immutable version settings.",
    {
      project_id:z.string().uuid(),selected_option:z.enum(VIDEO_SCRIPT_OPTION_IDS),approved:z.boolean().default(true),
      version_note:z.string().max(200).optional(),summary:z.string().max(5000).default(""),
      segments:z.array(segmentSchema).max(500),settings:z.record(z.any()).optional()
    },
    async args=>{try{
      const project=getVideoAnalysisProject(args.project_id);
      if(!project.settings.analysisBrief)throw new Error("Project chưa có content brief. Hãy tạo lại project bằng create_video_analysis_project.");
      return ok(saveVideoAnalysisScript({
        projectId:args.project_id,approved:args.approved,note:args.version_note,
        script:{summary:args.summary,language:"vi-VN",segments:args.segments.map(segment=>({id:segment.id,start:segment.start,end:segment.end,subtitleText:segment.subtitle_text,voiceOverText:segment.voice_over_text,speaker:segment.speaker,enabled:segment.enabled}))},
        settings:{...(args.settings||{}),ttsSpeed:project.settings.analysisBrief.ttsSpeed,geminiStylePrompt:project.settings.geminiStylePrompt,selectedScriptOption:args.selected_option}
      }));
    }catch(error){return fail(error)}}
  );

  server.tool("list_video_analysis_versions","List immutable script/settings versions.",{project_id:z.string().uuid()},async args=>{try{return ok({versions:getVideoAnalysisVersions(args.project_id)})}catch(error){return fail(error)}});
  server.tool("restore_video_analysis_version","Restore a version and create a new version recording that restore.",{project_id:z.string().uuid(),version_id:z.string().uuid()},async args=>{try{return ok(restoreVideoAnalysisVersion(args.project_id,args.version_id))}catch(error){return fail(error)}});
  server.tool("start_video_analysis_render","Start optional subtitle + TTS render. Script must already be approved.",{project_id:z.string().uuid()},async args=>{try{return ok(startVideoAnalysisJob(args.project_id))}catch(error){return fail(error)}});
  server.tool("get_video_analysis_job","Get render job progress and download URL.",{job_id:z.string().uuid()},async args=>{try{return ok(getVideoAnalysisJob(args.job_id))}catch(error){return fail(error)}});
  return server;
}
