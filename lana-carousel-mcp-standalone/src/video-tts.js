import textToSpeech from "@google-cloud/text-to-speech";
import {GoogleAuth} from "google-auth-library";
import fs from "node:fs";
import {AppError} from "./errors.js";
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

// Loi cua thu vien Google thuong dai nhieu dong: dong dau la ly do, phan sau la link huong dan.
// Cat cung theo so ky tu thi nguoi dung nhan mot mau URL dut doan ("...visit: h"), nen lay dong
// dau roi moi gioi han do dai. Duong dan tuyet doi va URL bi xoa han: thong bao nay di ra toi ca
// phien chia se link, ma loi credential cua google-auth-library co ca duong dan tep khoa trong do.
const providerReason=error=>{
 const firstLine=String(error?.message||error).split("\n")[0].trim()
  .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s'"`]+/giu,"…");
 return firstLine.length>120?`${firstLine.slice(0,119)}…`:firstLine;
};

// Thieu cau hinh la chuyen cua nguoi van hanh, khong phai cua nguoi bam nut, nen cau bao phai noi
// thang can dat bien nao va chi duoc loi di tam thoi. Dung 503 de phan biet voi 502 "da goi
// provider nhung hong": o day chua he goi ra ngoai lan nao.
const notConfigured=(detail,cause)=>{
 // generateVideoTtsTrack nem thang AppError ra ngoai truoc khi toi console.error cua no, nen
 // khong ghi o day thi cac ca thieu cau hinh khong de lai dau vet nao trong log.
 console.error("Vertex AI TTS not configured:",detail,cause||"");
 // Chi mach "doi sang Google TTS" khi loi di do that su thong: generateGoogle chuyen sang Cloud
 // TTS ngay khi GOOGLE_APPLICATION_CREDENTIALS co gia tri, nen luc bien do dang dat sai thi ca
 // hai nha cung cap cung hong va loi khuyen se thanh lac huong.
 const fallbackWorks=!process.env.GOOGLE_APPLICATION_CREDENTIALS&&!process.env.GOOGLE_CLOUD_PROJECT;
 return new AppError(
  "TTS_NOT_CONFIGURED",
  `Máy chủ chưa cấu hình Vertex AI (${detail}).${fallbackWorks?" Tạm thời hãy đổi Nhà cung cấp sang Google TTS." :" Xem log máy chủ để biết chi tiết."}`,
  503
 );
};

// GOOGLE_APPLICATION_CREDENTIALS tro toi tep khong doc duoc lam google-gax bo lai mot promise bi
// tu choi ma khong ai bat (createStub), va Node 22 bien no thanh uncaught exception — ca tien
// trinh http-server chet vi mot khoa TTS het han. Kiem tep truoc khi cham vao client la chan duoc
// ca duong do, dong thoi noi dung chuyen gi dang sai.
function credentialFileProblem(){
 const file=process.env.GOOGLE_APPLICATION_CREDENTIALS;
 if(!file)return "";
 try{ fs.accessSync(file, fs.constants.R_OK); return ""; }
 catch{ return "GOOGLE_APPLICATION_CREDENTIALS trỏ tới tệp không đọc được"; }
}

function vertexClient(){
 vertexClientPromise??=(async()=>{
  const auth=new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]});
  // getProjectId() nem khi khong do ra project chu khong tra ve rong, nen nhanh `if(!projectId)`
  // truoc day la code chet: may chu chua cau hinh thi nguoi dung nhan nguyen cau tieng Anh cua
  // thu vien kem mot URL bi cat do, thay vi loi huong dan da viet san ngay duoi no.
  let detectFailure="";
  const projectId=process.env.VERTEX_AI_PROJECT||process.env.GOOGLE_CLOUD_PROJECT
   ||await auth.getProjectId().catch(error=>{detectFailure=providerReason(error);return""});
  if(!projectId)throw notConfigured("chưa đặt VERTEX_AI_PROJECT",detectFailure);
  // Trong Docker chi ./data duoc mount, nen duong dan cua host tro thanh tep khong ton tai ben
  // trong container — ca dat nham nay pho bien hon han ca quen dat.
  const fileProblem=credentialFileProblem();
  if(fileProblem)throw notConfigured(fileProblem);
  // Khong noi thang la "chua dat GOOGLE_APPLICATION_CREDENTIALS": tren GCE/Cloud Run bien do dung
  // ra phai de trong vi credential den tu metadata server, bao vay se day nguoi van hanh di gan
  // mot tep khoa von khong phai van de.
  const client=await auth.getClient().catch(error=>{
   throw notConfigured("chưa có credential Google dùng được",providerReason(error));
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
  // Than phan hoi cua Vertex chua duong dan model kem project id va chi tiet IAM. Ghi log cho
  // nguoi van hanh doc, con phia nguoi goi chi can ma loi de phan biet thieu quyen (403) voi
  // sai ten model (404) — endpoint nay mo cho ca phien chia se link.
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
  // Cung cai bay nhu ben Vertex, va o day no da duoc dung lai: google-gax bo mot promise bi tu
  // choi khong ai bat khi tep khoa khong doc duoc, Node 22 nem tiep thanh uncaught exception va
  // http-server tat han. Chan truoc khi dung toi client.
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

export const GOOGLE_DEFAULT_VOICE="vi-VN-Neural2-D";
export const isVertexProvider=provider=>["gemini","vertex"].includes(provider);

// Hai nha cung cap dat ten giong theo hai he khac han nhau: Vertex nhan ten ngan (Kore, Puck),
// Google Cloud TTS nhan voice id day du (vi-VN-Neural2-D). Danh sach nay la nguon duy nhat cho
// ca bo chon trong studio lan phan kiem o route, de giao dien khong bao gio moi nguoi dung chon
// mot giong ma nha cung cap dang bat khong doc duoc.
export const VERTEX_VOICES=["Kore","Puck","Aoede","Charon","Fenrir"];
export const GOOGLE_VOICES=[
 "vi-VN-Neural2-A","vi-VN-Neural2-D",
 "vi-VN-Wavenet-A","vi-VN-Wavenet-B","vi-VN-Wavenet-C","vi-VN-Wavenet-D",
 "vi-VN-Standard-A","vi-VN-Standard-B","vi-VN-Standard-C","vi-VN-Standard-D"
];

// Brief do AI sinh ra co quyen ghi ttsVoice, nen mot du an co the dang giu giong nam ngoai danh
// sach tren. Giong do van phai nghe thu duoc, neu khong studio se tu choi doc dung thu ma ban
// render se doc.
export function allowedSampleVoices(projectSettings={},provider){
 if(isVertexProvider(provider))return VERTEX_VOICES;
 const persisted=projectSettings.ttsVoice;
 return persisted&&!GOOGLE_VOICES.includes(persisted)?[...GOOGLE_VOICES,persisted]:GOOGLE_VOICES;
}

// Nghe thu phai doc dung giong ma render se doc: nhanh Vertex lay geminiSpeaker1Voice, nhanh
// Google lay ttsVoice. Gia tri gui len chi duoc dung khi no thuoc he ten cua nha cung cap dang
// bat; ten cua he kia bi bo qua de roi ve dung giong cua render thay vi lam hong loi goi.
export function voiceSampleSettings(projectSettings={},{ttsProvider,voice}={}){
 const base={...projectSettings,ttsProvider,geminiMultiSpeaker:false};
 if(isVertexProvider(ttsProvider))return{...base,geminiSpeaker1Voice:voice};
 const picked=allowedSampleVoices(projectSettings,ttsProvider).includes(voice)?voice:"";
 return{...base,ttsVoice:picked||projectSettings.ttsVoice||GOOGLE_DEFAULT_VOICE};
}

export const sampledVoiceName=settings=>isVertexProvider(settings.ttsProvider)
 ?settings.geminiSpeaker1Voice
 :settings.ttsVoice;

// Thieu credential, het quota, model khong ton tai — nha cung cap nem ra Error thuong, va
// publicError goi tat ca thanh 500 "Loi he thong.". Nguoi bam "Nghe thu" vi the khong biet phai
// sua gi. Danh dau lai thanh 502 kem nguyen van ly do, va job render cung ghi lai duoc cau do.
export async function generateVideoTtsTrack(project,settings={}){
 try{
  return isVertexProvider(settings.ttsProvider)
   ?await generateVertex(project,settings)
   :await generateGoogle(project,settings);
 }catch(error){
  if(error instanceof AppError)throw error;
  const provider=isVertexProvider(settings.ttsProvider)?"Vertex AI":"Google TTS";
  // Ghi nguyen ven de con dau vet; phia nguoi goi chi nhan cau mo ta cua thu vien, da cat ngan.
  console.error(`${provider} TTS failed:`,error);
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
