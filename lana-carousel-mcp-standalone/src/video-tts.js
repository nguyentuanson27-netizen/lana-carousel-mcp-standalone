import textToSpeech from "@google-cloud/text-to-speech";
import {GoogleAuth} from "google-auth-library";
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
function vertexClient(){
 vertexClientPromise??=(async()=>{
  const auth=new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]});
  const projectId=process.env.VERTEX_AI_PROJECT||process.env.GOOGLE_CLOUD_PROJECT||await auth.getProjectId();
  if(!projectId)throw new Error("Chua cau hinh project cho Vertex AI.");
  return{projectId,client:await auth.getClient()};
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
 if(!response?.ok){const detail=await response.text().catch(()=>"");throw new Error(`Vertex AI TTS loi ${response?.status||"network"}: ${detail.slice(0,240)}`);}
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
  const client=new TextToSpeechClient();
  const [response]=await client.synthesizeSpeech({input:{text},voice:{languageCode:"vi-VN",name:settings.ttsVoice||"vi-VN-Neural2-D"},audioConfig:{audioEncoding:"MP3",speakingRate:1}});
  buffer=typeof response.audioContent==="string"?Buffer.from(response.audioContent,"base64"):Buffer.from(response.audioContent);
 }else{
  const chunks=text.match(/.{1,180}(?:\s|$)/gu)||[text],parts=[];
  for(const chunk of chunks){const url="https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q="+encodeURIComponent(chunk.trim());const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});if(!response.ok)throw new Error("Google TTS fallback loi "+response.status);parts.push(Buffer.from(await response.arrayBuffer()));}
  buffer=Buffer.concat(parts);
 }
 const words=text.trim().split(/\s+/u).length;
 return {dataUrl:`data:audio/mpeg;base64,${buffer.toString("base64")}`,durationSeconds:Math.max(1,words/2.7)};
}

export async function generateVideoTtsTrack(project,settings={}){
 return ["gemini","vertex"].includes(settings.ttsProvider)?generateVertex(project,settings):generateGoogle(project,settings);
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
