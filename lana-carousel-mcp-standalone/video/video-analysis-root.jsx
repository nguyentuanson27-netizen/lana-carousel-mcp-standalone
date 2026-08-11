import React from "react";
import {AbsoluteFill,Audio,Composition,OffthreadVideo,Sequence,useCurrentFrame,useVideoConfig} from "remotion";
import {VideoFonts} from "./fonts.jsx";

const FONT_STACKS={
 "TikTok Sans":"'TikTok Sans', Arial, Helvetica, sans-serif",
 Montserrat:"Montserrat, Arial, sans-serif",
 Poppins:"Poppins, Arial, sans-serif",
 Roboto:"Roboto, Arial, sans-serif",
 "Playfair Display":"'Playfair Display', Georgia, serif"
};
const splitWords=text=>String(text||"").trim().split(/\s+/u).filter(Boolean);
const Caption=({segment,settings})=>{
 const frame=useCurrentFrame(),{fps}=useVideoConfig(),text=String(segment.subtitleText||""),words=text.split(/(\s+)/u),wordParts=splitWords(text),segmentFrames=Math.max(1,Math.round((Number(segment.end)-Number(segment.start))*fps)),active=Math.min(wordParts.length-1,Math.floor(frame/segmentFrames*wordParts.length));let seen=-1;
 const wordMode=settings.subtitleStyle==="word";
 return <div style={{position:"absolute",left:`${settings.subtitleX??50}%`,top:`${settings.subtitlePosition??86}%`,transform:"translate(-50%,-50%)",width:wordMode?"auto":"88%",minWidth:wordMode?160:undefined,maxWidth:"94%",textAlign:"center",fontFamily:FONT_STACKS[settings.subtitleFont]||settings.subtitleFont||FONT_STACKS["TikTok Sans"],fontSize:settings.subtitleSize||52,fontWeight:700,lineHeight:1.18,color:settings.subtitleColor||"#fff",background:`${settings.subtitleBackgroundColor||"#000000"}${Math.round((settings.subtitleBackgroundOpacity??.72)*255).toString(16).padStart(2,"0")}`,padding:"14px 20px",borderRadius:18,whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{wordMode?<span style={{display:"inline-block",transform:"scale(1.06)"}}>{wordParts[active]||""}</span>:words.map((word,index)=>{if(word.trim())seen++;return <span key={index} style={{color:settings.subtitleStyle==="karaoke"&&seen===active?"#ffdf70":undefined}}>{word}</span>})}</div>;
};
// Mỗi đoạn có clip giọng đọc riêng đặt đúng mốc `start`, nên tiếng và phụ đề không lệch dần.
const VoiceTrack=({track,settings})=>{
 const {fps}=useVideoConfig();
 return <Sequence from={Math.round(Number(track.start||0)*fps)} durationInFrames={Math.max(1,Math.ceil(Number(track.duration||0)*fps))}>
  <Audio src={track.url} volume={settings.ttsVolume??1} playbackRate={Number(track.playbackRate)||1}/>
 </Sequence>;
};
const AnalyzedVideo=({sourceVideoUrl,segments=[],settings={},voiceTracks=[]})=>{const {fps}=useVideoConfig();return <AbsoluteFill style={{background:"#000"}}><VideoFonts/><OffthreadVideo src={sourceVideoUrl} volume={settings.originalAudioVolume??.25}/>{voiceTracks.filter(track=>track&&track.url).map((track,index)=><VoiceTrack key={track.id||index} track={track} settings={settings}/>)}{settings.subtitleEnabled!==false?segments.filter(segment=>segment.enabled!==false).map(segment=><Sequence key={segment.id} from={Math.round(Number(segment.start||0)*fps)} durationInFrames={Math.max(1,Math.round((Number(segment.end)-Number(segment.start))*fps))}><Caption segment={segment} settings={settings}/></Sequence>):null}</AbsoluteFill>};
export const LanaAnalyzedVideoComposition=()=> <Composition id="LanaAnalyzedVideo" component={AnalyzedVideo} width={1080} height={1920} fps={30} durationInFrames={300} defaultProps={{sourceVideoUrl:"",sourceDuration:0,voiceDuration:0,segments:[],settings:{},voiceTracks:[]}} calculateMetadata={({props})=>{const fps=30,d=Math.max(Number(props?.sourceDuration||0),Number(props?.voiceDuration||0),...(props?.segments||[]).map(segment=>Number(segment.end||0)),1);return{fps,durationInFrames:Math.ceil(d*fps)}}}/>;
