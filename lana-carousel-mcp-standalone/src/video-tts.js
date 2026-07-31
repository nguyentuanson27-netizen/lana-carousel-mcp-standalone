import textToSpeech from "@google-cloud/text-to-speech";
const {TextToSpeechClient}=textToSpeech;

const enabledSlides=project=>project.slides.filter(s=>(s.video||{}).enabled!==false);
const slideText=slide=>(slide.video||{}).caption||slide.body||slide.headline||"";
const pcmToWav=(pcm,sampleRate=24000)=>{
 const header=Buffer.alloc(44),dataSize=pcm.length;
 header.write("RIFF",0);header.writeUInt32LE(36+dataSize,4);header.write("WAVE",8);header.write("fmt ",12);
 header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sampleRate,24);
 header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write("data",36);header.writeUInt32LE(dataSize,40);
 return Buffer.concat([header,pcm]);
};
const voiceConfig=name=>({prebuiltVoiceConfig:{voiceName:name||"Kore"}});

async function generateGemini(project,settings){
 const key=process.env.GEMINI_API_KEY;
 if(!key)throw new Error("Chua cau hinh GEMINI_API_KEY tren VPS.");
 const slides=enabledSlides(project).filter(slideText);
 if(!slides.length)return "";
 const multi=Boolean(settings.geminiMultiSpeaker),speaker1=(settings.geminiSpeaker1Name||"Nguoi dan").trim(),speaker2=(settings.geminiSpeaker2Name||"Khach moi").trim();
 const transcript=multi?slides.map((s,i)=>`${(s.video||{}).speaker==="speaker2"?speaker2:(s.video||{}).speaker==="speaker1"?speaker1:i%2?speaker2:speaker1}: ${slideText(s)}`).join("\n"):slides.map(slideText).join(". ");
 const pace=Number(settings.ttsSpeed||1),style=(settings.geminiStylePrompt||"Doc tieng Viet tu nhien, ro rang, phu hop video mang xa hoi.").trim();
 const prompt=`Synthesize the transcript only. Do not read these instructions aloud. Language: Vietnamese. Style: ${style} Pace: ${pace.toFixed(2)}x.\n\nTranscript:\n${transcript}`;
 const speechConfig={languageCode:"vi-VN"};
 if(multi)speechConfig.multiSpeakerVoiceConfig={speakerVoiceConfigs:[
  {speaker:speaker1,voiceConfig:voiceConfig(settings.geminiSpeaker1Voice||"Kore")},
  {speaker:speaker2,voiceConfig:voiceConfig(settings.geminiSpeaker2Voice||"Puck")}
 ]};else speechConfig.voiceConfig=voiceConfig(settings.geminiSpeaker1Voice||"Kore");
 const model=settings.geminiModel||"gemini-2.5-flash-preview-tts";
 let response;
 for(let attempt=0;attempt<3;attempt++){
  response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:["AUDIO"],speechConfig}})});
  if(response.ok||response.status<500)break;
  await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));
 }
 if(!response?.ok){const detail=await response.text().catch(()=>"");throw new Error(`Gemini TTS loi ${response?.status||"network"}: ${detail.slice(0,240)}`);}
 const body=await response.json(),part=body?.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data||p.inline_data?.data),base64=part?.inlineData?.data||part?.inline_data?.data;
 if(!base64)throw new Error("Gemini TTS khong tra ve du lieu am thanh.");
 const mime=part?.inlineData?.mimeType||part?.inline_data?.mime_type||"audio/L16;rate=24000";
 if(/wav/i.test(mime))return `data:audio/wav;base64,${base64}`;
 return `data:audio/wav;base64,${pcmToWav(Buffer.from(base64,"base64")).toString("base64")}`;
}

async function generateGoogle(project,settings){
 const text=enabledSlides(project).map(slideText).filter(Boolean).join(". ");
 if(!text)return "";
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
 return `data:audio/mpeg;base64,${buffer.toString("base64")}`;
}

export async function generateVideoTtsData(project,settings={}){
 return settings.ttsProvider==="gemini"?generateGemini(project,settings):generateGoogle(project,settings);
}
