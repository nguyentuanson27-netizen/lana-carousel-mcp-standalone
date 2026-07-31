import textToSpeech from "@google-cloud/text-to-speech";
const {TextToSpeechClient}=textToSpeech;
export async function generateVideoTtsData(project,voiceName="vi-VN-Neural2-D"){
 const text=project.slides.filter(s=>(s.video||{}).enabled!==false).map(s=>(s.video||{}).caption||s.body||s.headline).filter(Boolean).join(". ");
 if(!text)return "";
 let buffer;
 if(process.env.GOOGLE_APPLICATION_CREDENTIALS||process.env.GOOGLE_CLOUD_PROJECT){
  const client=new TextToSpeechClient();
  const [response]=await client.synthesizeSpeech({input:{text},voice:{languageCode:"vi-VN",name:voiceName},audioConfig:{audioEncoding:"MP3",speakingRate:1.03}});
  buffer=typeof response.audioContent==="string"?Buffer.from(response.audioContent,"base64"):Buffer.from(response.audioContent);
 }else{
  const chunks=text.match(/.{1,180}(?:\s|$)/gu)||[text],parts=[];
  for(const chunk of chunks){const url="https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q="+encodeURIComponent(chunk.trim());const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});if(!response.ok)throw new Error("Google TTS fallback lỗi "+response.status);parts.push(Buffer.from(await response.arrayBuffer()));}
  buffer=Buffer.concat(parts);
 }
 return `data:audio/mpeg;base64,${buffer.toString("base64")}`;
}
