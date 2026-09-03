import textToSpeech from "@google-cloud/text-to-speech";
import {GoogleAuth} from "google-auth-library";
import fs from "node:fs";
import {AppError} from "./errors.js";
import {config} from "./config.js";
import {downloadRemoteAudioBuffer} from "./remote-media.js";
const {TextToSpeechClient}=textToSpeech;

const enabledSlides=project=>project.slides.filter(s=>(s.video||{}).enabled!==false);
const slideText=slide=>(slide.video||{}).caption||slide.body||slide.headline||"";
const emptyTrack=()=>({dataUrl:"",durationSeconds:0});
const pcmToWav=(pcm,sampleRate=24000)=>{
 const header=Buffer.alloc(44),dataSize=pcm.length;
 header.write("RIFF",0);header.writeUInt32LE(36+dataSize,4);header.write("WAVE",8);header.write("fmt ",12);
 header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);
 header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write("data",36);header.writeUInt32LE(dataSize,40);
 return Buffer.concat([header,pcm]);
};
const voiceConfig=name=>({prebuiltVoiceConfig:{voiceName:name||"Kore"}});

// Voice-over được tong hop theo tung doan nen ham nay bi goi nhieu lan trong mot render.
// Giu lai client de khong phai lay access token lai tu dau moi doan; getAccessToken cua
// google-auth-library tu cache va tu lam moi token khi sap het han.
let vertexClientPromise;

// Thong bao nay di ra toi ca phien chia se link, nen chi nhung ly do da biet moi duoc noi ra.
// Loc bang bieu thuc chinh quy la loc den va kieu gi cung sot: duong dan Windows "C:\\..." khong
// co dau gach cheo xuoi nao de bat, va loi JSON.parse cua google-auth-library con nhet ca noi
// dung tep khoa vao cau bao. Danh sach trang thi khong co khe nao de sot — nguyen van loi luon
// nam trong log may chu.
const KNOWN_REASONS=[
 [/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/i,"không kết nối được tới nhà cung cấp"],
 [/Unable to detect a Project Id/i,"không dò được project id"],
 [/Could not load the default credentials|invalid_grant|unauthorized_client|invalid_client/i,"credential không dùng được"],
 [/is not valid JSON|Unexpected token|JSON at position/i,"tệp credential không phải JSON hợp lệ"],
 [/does not exist, or it is not a file|ENOENT/i,"không mở được tệp credential"],
 [/permission|forbidden|PERMISSION_DENIED|\b403\b/i,"không đủ quyền trên project"],
 [/RESOURCE_EXHAUSTED|quota|rate limit|\b429\b/i,"hết hạn mức của nhà cung cấp"],
 [/NOT_FOUND|\b404\b/i,"không tìm thấy model hoặc endpoint"],
 [/UNAUTHENTICATED|\b401\b/i,"credential bị từ chối"]
];
const providerReason=error=>{
 const raw=String(error?.message||error);
 return (KNOWN_REASONS.find(([pattern])=>pattern.test(raw))||[,"lỗi chưa rõ, xem log máy chủ"])[1];
};

// Thieu cau hinh la chuyen cua nguoi van hanh, khong phai cua nguoi bam nut, nen cau bao phai noi
// thang can dat bien nao va chi duoc loi di tam thoi. Dung 503 de phan biet voi 502 "da goi
// provider nhung hong": o day chua he goi ra ngoai lan nao.
// Ngay ca log cung khong duoc chua nguyen van loi: loi JSON.parse cua google-auth-library nhet
// noi dung tep khoa vao message, con loi ENOENT thi nhet duong dan. Log di ra file, di vao dich
// vu gom log, va thuong de o quyen doc rong hon han thu ma nguoi ngoai thay duoc. Ghi ten loi,
// ma loi va nhom ly do — du de lan ra chuyen gi, khong mang theo bi mat nao.
export const safeCause=error=>{
 if(!error)return "";
 const code=String(error?.code??"").slice(0,40);
 const status=Number(error?.status??error?.statusCode)||0;
 return `${error?.name||"Error"}${code?` code=${code}`:""}${status?` status=${status}`:""} → ${providerReason(error)}`;
};

const notConfigured=(detail,cause)=>{
 console.error("Vertex AI TTS not configured:",detail,safeCause(cause));
 const fallbackWorks=!process.env.GOOGLE_APPLICATION_CREDENTIALS&&!process.env.GOOGLE_CLOUD_PROJECT;
 return new AppError(
  "TTS_NOT_CONFIGURED",
  `Máy chủ chưa cấu hình Vertex AI (${detail}).${fallbackWorks?" Tạm thời hãy đổi Nhà cung cấp sang Google TTS." :" Xem log máy chủ để biết chi tiết."}`,
  503
 );
};

const CREDENTIAL_REQUIREMENTS={
 service_account:["client_email","private_key"],
 authorized_user:["client_id","client_secret","refresh_token"]
};

function credentialFileProblem(){
 const file=process.env.GOOGLE_APPLICATION_CREDENTIALS;
 if(!file)return "";
 let raw;
 try{
  if(!fs.statSync(file).isFile())return "GOOGLE_APPLICATION_CREDENTIALS trỏ tới thư mục chứ không phải tệp";
  raw=fs.readFileSync(file,"utf8");
 }catch{ return "GOOGLE_APPLICATION_CREDENTIALS trỏ tới tệp không đọc được"; }
 let parsed;
 try{ parsed=JSON.parse(raw); }
 catch{ return "tệp credential không phải JSON hợp lệ"; }
 const required=CREDENTIAL_REQUIREMENTS[parsed?.type];
 if(!required)return `chỉ nhận credential loại ${Object.keys(CREDENTIAL_REQUIREMENTS).join(" hoặc ")}`;
 const missing=required.filter(field=>!parsed[field]);
 if(missing.length)return `tệp credential thiếu trường ${missing.join(", ")}`;
 return "";
}

function vertexClient(){
 vertexClientPromise??=(async()=>{
  const auth=new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]});
  const fileProblem=credentialFileProblem();
  if(fileProblem)throw notConfigured(fileProblem);
  let detectFailure;
  const projectId=process.env.VERTEX_AI_PROJECT||process.env.GOOGLE_CLOUD_PROJECT
   ||await auth.getProjectId().catch(error=>{detectFailure=error;return""});
  if(!projectId)throw notConfigured("chưa đặt VERTEX_AI_PROJECT",detectFailure);
  const client=await auth.getClient().catch(error=>{
   throw notConfigured("chưa có credential Google dùng được",error);
  });
  return{projectId,client};
 })().catch(error=>{
  vertexClientPromise=undefined;
  throw error;
 });
 return vertexClientPromise;
}

async function generateVertex(project,settings){
 const {projectId,client}=await vertexClient();
 const tokenResult=await client.getAccessToken(),accessToken=typeof tokenResult==="string"?tokenResult:tokenResult?.token;
 if(!accessToken)throw new Error("Khong lay duoc access token Vertex AI.");
 const slides=enabledSlides(project).filter(slideText);
 if(!slides.length)return emptyTrack();
 const multi=Boolean(settings.geminiMultiSpeaker),speaker1=(settings.geminiSpeaker1Name||"Nguoi dan").trim(),speaker2=(settings.geminiSpeaker2Name||"Khach moi").trim();
 const transcript=multi?slides.map((s,i)=>`${(s.video||{}).speaker==="speaker2"?speaker2:(s.video||{}).speaker==="speaker1"?speaker1:i%2?speaker2:speaker1}: ${slideText(s)}`).join("\n"):slides.map(slideText).join(". ");
 const style=(settings.geminiStylePrompt||"Doc tieng Viet tu nhien, ro rang, phu hop video mang xa hoi.").trim();
 const prompt=`Synthesize the transcript only. Do not read these instructions aloud. Language: Vietnamese. Style: ${style}\n\nTranscript:\n${transcript}`;
 const speechConfig={languageCode:"vi-VN"};
 if(multi)speechConfig.multiSpeakerVoiceConfig={speakerVoiceConfigs:[
  {speaker:speaker1,voiceConfig:voiceConfig(settings.geminiSpeaker1Voice||"Kore")},
  {speaker:speaker2,voiceConfig:voiceConfig(settings.geminiSpeaker2Voice||"Puck")}
 ]};else speechConfig.voiceConfig=voiceConfig(settings.geminiSpeaker1Voice||"Kore");
 const legacyModels={"gemini-2.5-flash-preview-tts":"gemini-2.5-flash-tts","gemini-2.5-pro-preview-tts":"gemini-2.5-pro-tts"};
 const model=legacyModels[settings.geminiModel]||settings.geminiModel||"gemini-2.5-flash-tts",location=process.env.VERTEX_AI_LOCATION||process.env.GOOGLE_CLOUD_LOCATION||"global";
 const host=location==="global"?"aiplatform.googleapis.com":`${location}-aiplatform.googleapis.com`;
 const endpoint=`https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
 let response;
 for(let attempt=0;attempt<3;attempt++){
  response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${accessToken}`},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{responseModalities:["AUDIO"],speechConfig}})});
  if(response.ok||response.status<500)break;
  await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));
 }
 if(!response?.ok){
  const detail=await response.text().catch(()=>"");
  console.error("Vertex AI TTS error body:",detail.slice(0,500));
  throw new AppError("TTS_PROVIDER_FAILED",`Vertex AI TTS lỗi ${response?.status||"mạng"}. Xem log máy chủ để biết chi tiết.`,502);
 }
 const body=await response.json(),part=body?.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data||p.inline_data?.data),base64=part?.inlineData?.data||part?.inline_data?.data;
 if(!base64)throw new Error("Vertex AI TTS khong tra ve du lieu am thanh.");
 const mime=part?.inlineData?.mimeType||part?.inline_data?.mime_type||"audio/L16;rate=24000";
 const pcm=Buffer.from(base64,"base64"),durationSeconds=pcm.length/48000;
 if(/wav/i.test(mime))return {dataUrl:`data:audio/wav;base64,${base64}`,durationSeconds};
 return {dataUrl:`data:audio/wav;base64,${pcmToWav(pcm).toString("base64")}`,durationSeconds};
}

async function generateGoogle(project,settings){
 const text=enabledSlides(project).map(slideText).filter(Boolean).join(". ");
 if(!text)return emptyTrack();
 let buffer;
 if(process.env.GOOGLE_APPLICATION_CREDENTIALS||process.env.GOOGLE_CLOUD_PROJECT){
  const fileProblem=credentialFileProblem();
  if(fileProblem)throw new AppError("TTS_NOT_CONFIGURED",`Máy chủ chưa cấu hình Google TTS (${fileProblem}). Xem log máy chủ để biết chi tiết.`,503);
  const client=new TextToSpeechClient();
  const [response]=await client.synthesizeSpeech({input:{text},voice:{languageCode:"vi-VN",name:settings.ttsVoice||GOOGLE_DEFAULT_VOICE},audioConfig:{audioEncoding:"MP3",speakingRate:1}});
  buffer=typeof response.audioContent==="string"?Buffer.from(response.audioContent,"base64"):Buffer.from(response.audioContent);
 }else{
  const chunks=text.match(/.{1,180}(?:\s|$)/gu)||[text],parts=[];
  for(const chunk of chunks){const url="https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q="+encodeURIComponent(chunk.trim());const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});if(!response.ok)throw new Error("Google TTS fallback loi "+response.status);parts.push(Buffer.from(await response.arrayBuffer()));}
  buffer=Buffer.concat(parts);
 }
 const words=text.trim().split(/\s+/u).length;
 return {dataUrl:`data:audio/mpeg;base64,${buffer.toString("base64")}`,durationSeconds:Math.max(1,words/2.7)};
}

export const LUCYLAB_VOICES = [
 { id: "vcXEe1p3FxPfpswf3BhwbG", name: "My Review", label: "My Review (Nữ miền Nam)" },
 { id: "orBfJ4Q68FyVbckjJgDvkj", name: "Thư Review", label: "Thư Review (Nữ miền Nam)" },
 { id: "nqak8C85bsAG5mihyunRkj", name: "Chi Chi", label: "Chi Chi (Nữ miền Nam)" },
 { id: "5r2MVjMfzwsSDzTpaLjbY9", name: "Adam 3", label: "Adam 3 (Nam miền Nam)" },
 { id: "mhsL3CPLxmLYdSTKp3GANz", name: "Truyện Audio (tiết kiệm)", label: "Truyện Audio - tiết kiệm (Nữ miền Bắc)" },
 { id: "uCMfUVPwStduZMyFC7iuQv", name: "Trinh Review", label: "Trinh Review (Nữ miền Nam)" },
 { id: "shAfRJNufJUhQSgJUL8NST", name: "Hà Review", label: "Hà Review (Nữ miền Bắc)" },
 { id: "wkKKgWq7ajLoSaVH38Y3gE", name: "Trinh Review (style 2)", label: "Trinh Review style 2 (Nữ miền Nam)" },
 { id: "un7ZPTWAwwYAMNdpgMwHjf", name: "Adam 2", label: "Adam 2 (Nam miền Nam)" },
 { id: "mhsL3CPLxmLYdSTKp3GANj", name: "Giọng Adam (monotone)", label: "Giọng Adam - monotone (Nam miền Bắc)" }
];
export const LUCYLAB_VOICE_IDS = LUCYLAB_VOICES.map(v => v.id);
export const LUCYLAB_DEFAULT_VOICE = "vcXEe1p3FxPfpswf3BhwbG";
export const isLucylabProvider = provider => ["lucylab", "lucylab-ai", "lucylab_ai"].includes(String(provider || "").toLowerCase());

export function resolveLucylabVoice(settings = {}) {
 const candidates = [settings.lucylabVoice, settings.userVoiceId, settings.ttsVoice];
 return candidates.find(voice => LUCYLAB_VOICE_IDS.includes(voice)) || LUCYLAB_DEFAULT_VOICE;
}

// Reading speed belongs to the render timeline. Keeping provider synthesis at 1x means cached
// bytes depend only on text + voice, exactly like Google/Vertex, and avoids applying ttsSpeed twice.
export function lucylabSynthesisInput(text, settings = {}) {
 return {
  text: String(text || ""),
  userVoiceId: resolveLucylabVoice(settings),
  speed: 1
 };
}

const lucylabUnavailable=(message="Lucylab AI tạm thời không đọc được. Vui lòng thử lại.",status=502)=>
 new AppError("TTS_PROVIDER_FAILED",message,status);
const logLucylabFailure=(context,error)=>console.error(`Lucylab ${context}:`,safeCause(error));

export async function getLucylabCredits() {
 const apiKey = String(process.env.LUCYLAB_API_KEY || config.lucylabApiKey || "").trim();
 if (!apiKey) {
  throw new AppError("TTS_NOT_CONFIGURED", "Máy chủ chưa cấu hình Lucylab API Key (thiếu LUCYLAB_API_KEY).", 503);
 }
 let res;
 try {
  res = await fetch("https://api.lucylab.io/json-rpc", {
   method: "POST",
   headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
   },
   body: JSON.stringify({ method: "getUserInfo", input: {} })
  });
 } catch (error) {
  logLucylabFailure("credit request failed",error);
  throw lucylabUnavailable("Không lấy được số credit Lucylab. Vui lòng thử lại.");
 }
 if (!res.ok) {
  console.error("Lucylab credit request rejected:",`status=${res.status}`);
  throw lucylabUnavailable("Không lấy được số credit Lucylab. Vui lòng thử lại.");
 }
 const data = await res.json().catch(() => ({}));
 if (data.error) {
  console.error("Lucylab credit JSON-RPC returned an error response.");
  throw lucylabUnavailable("Không lấy được số credit Lucylab. Vui lòng thử lại.");
 }
 const user = data.result?.user || {};
 return {
  creditsRemaining: Number(user.creditsRemaining ?? 0),
  isPremium: Boolean(user.isPremium),
  subscriptionTier: user.subscriptionTier || "free",
  updatedAt: user.updatedAt || new Date().toISOString()
 };
}

async function generateLucylab(project, settings = {}) {
 const text = enabledSlides(project).map(slideText).filter(Boolean).join(". ");
 if (!text) return emptyTrack();

 const apiKey = String(process.env.LUCYLAB_API_KEY || config.lucylabApiKey || "").trim();
 if (!apiKey) {
  throw new AppError("TTS_NOT_CONFIGURED", "Máy chủ chưa cấu hình Lucylab API Key (thiếu LUCYLAB_API_KEY).", 503);
 }

 let startRes;
 try {
  startRes = await fetch("https://api.lucylab.io/json-rpc", {
   method: "POST",
   headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
   },
   body: JSON.stringify({
    method: "ttsLongText",
    input: lucylabSynthesisInput(text, settings)
   })
  });
 } catch (error) {
  logLucylabFailure("synthesis request failed",error);
  throw lucylabUnavailable();
 }

 if (!startRes.ok) {
  console.error("Lucylab synthesis request rejected:",`status=${startRes.status}`);
  throw lucylabUnavailable();
 }

 const startData = await startRes.json().catch(() => ({}));
 if (startData.error) {
  console.error("Lucylab synthesis JSON-RPC returned an error response.");
  throw lucylabUnavailable();
 }

 const exportId = startData.result?.projectExportId;
 if (!exportId) {
  console.error("Lucylab synthesis response omitted projectExportId.");
  throw lucylabUnavailable();
 }

 let audioUrl = "";
 const maxAttempts = 30;
 for (let attempt = 0; attempt < maxAttempts; attempt++) {
  await new Promise(r => setTimeout(r, 1500));
  let statusRes;
  try {
   statusRes = await fetch("https://api.lucylab.io/json-rpc", {
    method: "POST",
    headers: {
     "Authorization": `Bearer ${apiKey}`,
     "Content-Type": "application/json"
    },
    body: JSON.stringify({
     method: "getExportStatus",
     input: { projectExportId: exportId }
    })
   });
  } catch (error) {
   logLucylabFailure("export status request failed",error);
   continue;
  }

  if (!statusRes.ok) {
   console.error("Lucylab export status request rejected:",`status=${statusRes.status}`);
   continue;
  }
  const statusData = await statusRes.json().catch(() => ({}));
  const result = statusData.result || {};
  if (result.state === "failed" || statusData.error) {
   console.error("Lucylab export reported a failed state.");
   throw lucylabUnavailable();
  }
  if (result.state === "completed" && result.url) {
   audioUrl = result.url;
   break;
  }
 }

 if (!audioUrl) {
  throw lucylabUnavailable("Lucylab AI tạo audio quá lâu. Vui lòng thử lại.",504);
 }

 let downloaded;
 try {
  downloaded = await downloadRemoteAudioBuffer(audioUrl);
 } catch (error) {
  logLucylabFailure("export download failed",error);
  throw lucylabUnavailable();
 }
 const buffer = downloaded.buffer;
 const isWav = buffer.length > 44
  && buffer.toString("ascii", 0, 4) === "RIFF"
  && buffer.toString("ascii", 8, 12) === "WAVE";
 if (!isWav) {
  console.error("Lucylab export did not contain a WAV payload.");
  throw lucylabUnavailable();
 }

 let durationSeconds = 0;
 const byteRate = buffer.readUInt32LE(28);
 if (byteRate > 0) durationSeconds = (buffer.length - 44) / byteRate;
 if (!durationSeconds || !Number.isFinite(durationSeconds)) {
  const words = text.trim().split(/\s+/u).length;
  durationSeconds = Math.max(1, words / 2.5);
 }

 return {
  dataUrl: `data:audio/wav;base64,${buffer.toString("base64")}`,
  durationSeconds: Number(durationSeconds.toFixed(2))
 };
}

export const GOOGLE_DEFAULT_VOICE="vi-VN-Neural2-D";
export const isVertexProvider=provider=>["gemini","vertex"].includes(provider);

export const VERTEX_VOICES=["Kore","Puck","Aoede","Charon","Fenrir","Laomedeia","Leda","Pulcherrima","Achernar"];
export const GOOGLE_VOICES=[
 "vi-VN-Neural2-A","vi-VN-Neural2-D",
 "vi-VN-Wavenet-A","vi-VN-Wavenet-B","vi-VN-Wavenet-C","vi-VN-Wavenet-D",
 "vi-VN-Standard-A","vi-VN-Standard-B","vi-VN-Standard-C","vi-VN-Standard-D"
];

export function allowedSampleVoices(projectSettings={},provider){
 if(isLucylabProvider(provider))return LUCYLAB_VOICE_IDS;
 if(isVertexProvider(provider))return VERTEX_VOICES;
 const persisted=projectSettings.ttsVoice;
 return persisted&&!GOOGLE_VOICES.includes(persisted)?[...GOOGLE_VOICES,persisted]:GOOGLE_VOICES;
}

export function voiceSampleSettings(projectSettings={},{ttsProvider,voice}={}){
 const base={...projectSettings,ttsProvider,geminiMultiSpeaker:false};
 if(isLucylabProvider(ttsProvider)){
  const picked=LUCYLAB_VOICE_IDS.includes(voice)?voice:LUCYLAB_DEFAULT_VOICE;
  return{...base,ttsVoice:picked,lucylabVoice:picked};
 }
 if(isVertexProvider(ttsProvider))return{...base,geminiSpeaker1Voice:voice};
 const picked=allowedSampleVoices(projectSettings,ttsProvider).includes(voice)?voice:"";
 return{...base,ttsVoice:picked||projectSettings.ttsVoice||GOOGLE_DEFAULT_VOICE};
}

export const sampledVoiceName=settings=>{
 if(isLucylabProvider(settings.ttsProvider)){
  const id=resolveLucylabVoice(settings);
  const v=LUCYLAB_VOICES.find(item=>item.id===id);
  return v?v.name:"My Review";
 }
 return isVertexProvider(settings.ttsProvider)?settings.geminiSpeaker1Voice:settings.ttsVoice;
};

export async function generateVideoTtsTrack(project,settings={}){
 try{
  if(isLucylabProvider(settings.ttsProvider))return await generateLucylab(project,settings);
  return isVertexProvider(settings.ttsProvider)
   ?await generateVertex(project,settings)
   :await generateGoogle(project,settings);
 }catch(error){
  if(error instanceof AppError)throw error;
  const provider=isLucylabProvider(settings.ttsProvider)?"Lucylab AI":isVertexProvider(settings.ttsProvider)?"Vertex AI":"Google TTS";
  console.error(`${provider} TTS failed:`,safeCause(error));
  throw new AppError("TTS_PROVIDER_FAILED",`${provider} không đọc được: ${providerReason(error)}`,502);
 }
}

// Doc mot cau don le: dung cho tung doan voice-over, cho nghe thu giong va cho preview.
export async function generateSpeechForText(text,settings={}){
 const content=String(text||"").trim();
 if(!content)return emptyTrack();
 return generateVideoTtsTrack({slides:[{headline:content,body:content,video:{enabled:true,caption:content}}]},settings);
}
export async function generateVideoTtsData(project,settings={}){
 return (await generateVideoTtsTrack(project,settings))?.dataUrl||"";
}
