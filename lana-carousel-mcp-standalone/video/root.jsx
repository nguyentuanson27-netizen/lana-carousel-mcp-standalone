import React from "react";
import {AbsoluteFill, Audio, Composition, Img, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {LanaAnalyzedVideoComposition} from "./video-analysis-root.jsx";
import {VideoFonts} from "./fonts.jsx";

const clamp = {extrapolateLeft:"clamp",extrapolateRight:"clamp"};
const dims = {vertical:[1080,1920],square:[1080,1080],landscape:[1920,1080]};

const motionTransform = (scene,frame,duration) => {
  const p=interpolate(frame,[0,duration],[0,1],clamp),motion=scene.motion;
  if(motion==="zoom-in") return `scale(${1+p*.1})`;
  if(motion==="zoom-out") return `scale(${1.1-p*.1})`;
  if(motion==="pan-left") return `scale(1.08) translateX(${4-p*8}%)`;
  if(motion==="pan-right") return `scale(1.08) translateX(${-4+p*8}%)`;
  if(motion==="ken-burns") return `scale(${1.03+p*.1}) translate(${3-p*6}%,${2-p*4}%)`;
  if(motion==="smart-ken-burns"){
    const power=Number(scene.kenBurnsIntensity||.14),dx=(50-Number(scene.focusX||50))*.08,dy=(50-Number(scene.focusY||50))*.08;
    return `scale(${1.02+p*power}) translate(${dx*p}%,${dy*p}%)`;
  }
  return "scale(1)";
};

const rangeNumber=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
const normalizedRanges=layer=>{
  const content=String(layer.content||""),length=content.length;
  const legacy=(layer.sizeRanges||[]).map(range=>({...range,size:range.size}));
  return [...legacy,...(layer.styleRanges||[])].map(range=>({
    start:Math.max(0,Math.min(length,Math.round(rangeNumber(range.start,0)))),
    end:Math.max(0,Math.min(length,Math.round(rangeNumber(range.end,0)))),
    ...(range.size==null?{}:{size:Math.max(24,Math.min(220,rangeNumber(range.size,layer.size||72)))}),
    ...(range.font?{font:String(range.font)}:{}),
    ...(/^#[0-9a-f]{6}$/iu.test(range.color)?{color:range.color}:{}),
    ...(range.weight?{weight:String(range.weight)}:{}),
    ...(range.underline==null?{}:{underline:Boolean(range.underline)})
  })).filter(range=>range.end>range.start);
};
const styleAt=(layer,index)=>{
  const style={font:layer.font||"TikTok Sans",size:layer.size||72,color:layer.color||"#fff",weight:layer.weight||700,underline:Boolean(layer.underline)};
  for(const range of normalizedRanges(layer)) if(index>=range.start&&index<range.end) Object.assign(style,range);
  return style;
};
const styledSegments=(layer,text,offset=0)=>{
  if(!text)return[];
  const segments=[];
  for(let i=0;i<text.length;i+=1){
    const style=styleAt(layer,offset+i),previous=segments.at(-1);
    const key=`${style.font}|${style.size}|${style.color}|${style.weight}|${style.underline}`;
    if(previous?.key===key)previous.text+=text[i];
    else segments.push({key,text:text[i],style});
  }
  return segments;
};
const StyledText=({layer,text,offset=0})=><>{styledSegments(layer,text,offset).map((segment,index)=><span key={`${segment.key}-${index}`} style={{fontFamily:segment.style.font,fontSize:segment.style.size,color:segment.style.color,fontWeight:segment.style.weight,textDecoration:segment.style.underline?"underline":"none"}}>{segment.text}</span>)}</>;
const unitsFor=(content,animation)=>{
  if(animation==="by-line"){
    let offset=0;
    return content.split("\n").map((text,index)=>{const unit={text,start:offset,display:"block",key:`line-${index}`};offset+=text.length+1;return unit;});
  }
  let offset=0;
  return (content.match(/\S+\s*|\s+/gu)||[]).map((text,index)=>{const unit={text,start:offset,display:"inline",key:`word-${index}`};offset+=text.length;return unit;});
};
const alphaHex=value=>Math.round(Math.max(0,Math.min(1,value))*255).toString(16).padStart(2,"0");

const RichLayer=({layer,animation})=>{
  const rawFrame=useCurrentFrame(),{fps}=useVideoConfig(),frame=Math.max(0,rawFrame-Number(layer.animationDelay||0)*fps);
  const entrance=animation==="none"||animation==="typewriter"||animation==="by-word"||animation==="by-line"?1:spring({frame,fps,config:{damping:16,stiffness:110}});
  const transform=animation==="typewriter"?"none":`translateY(${(1-entrance)*35}px) scale(${.96+entrance*.04})`;
  const content=String(layer.content||"");
  const chars=animation==="typewriter"?Math.floor(interpolate(frame,[0,fps*1.2],[0,content.length],clamp)):content.length;
  let rendered;
  if(animation==="by-word"||animation==="by-line"){
    rendered=unitsFor(content,animation).map((unit,index)=>{
      const progress=spring({frame:frame-index*3,fps,config:{damping:18,stiffness:120}});
      return <span key={unit.key} style={{display:unit.display,opacity:progress,transform:`translateY(${(1-progress)*18}px)`}}><StyledText layer={layer} text={unit.text} offset={unit.start}/></span>;
    });
  }else rendered=<StyledText layer={layer} text={content.slice(0,chars)} offset={0}/>;

  return <div style={{
    position:"absolute",left:`${layer.x??50}%`,top:`${layer.y??80}%`,
    transform:`translate(-50%,-50%) ${transform} rotate(${layer.rotation||0}deg)`,
    opacity:(layer.opacity??1)*entrance,width:layer.boxEnabled?`${layer.boxWidth||80}%`:"auto",maxWidth:"94%",
    padding:layer.boxEnabled?`${layer.boxPaddingY||20}px ${layer.boxPaddingX||32}px`:"6px 10px",
    background:layer.boxEnabled?`${layer.boxColor||"#fff"}${alphaHex(layer.boxOpacity??.9)}`:"transparent",
    border:layer.boxEnabled?`${layer.boxBorderWidth||0}px solid ${layer.boxBorderColor||"#333"}${alphaHex(layer.boxBorderOpacity??1)}`:"none",
    borderRadius:layer.boxRadius||0,textAlign:layer.align||"center",lineHeight:1.12,whiteSpace:"pre-wrap",
    textShadow:layer.boxEnabled?"none":"0 3px 8px #000,0 0 3px #000"
  }}>{rendered}</div>;
};

const Caption=({text,style="karaoke",position=88,font="TikTok Sans",color="#FFFFFF",backgroundColor="#000000",backgroundOpacity=.72,size=38})=>{
  const frame=useCurrentFrame(),{durationInFrames}=useVideoConfig(),words=String(text||"").split(/(\s+)/),wordParts=words.filter(x=>x.trim()),active=Math.min(wordParts.length-1,Math.floor(frame/Math.max(1,durationInFrames)*wordParts.length));let seen=-1;
  return <div style={{position:"absolute",left:"7%",right:"7%",top:`${position}%`,transform:"translateY(-50%)",padding:"16px 22px",borderRadius:18,background:style==="pop"?"#fff":`${backgroundColor}${alphaHex(backgroundOpacity)}`,color:style==="pop"?"#111":color,font:`700 ${size}px ${font},Arial`,textAlign:"center",lineHeight:1.25}}>{words.map((word,i)=>{if(word.trim())seen++;const on=seen===active;return <span key={i} style={{color:style==="karaoke"&&on?"#ffdf70":undefined,background:style==="word"&&on?"#8d3f3d":undefined,borderRadius:6,padding:style==="word"&&on?"2px 5px":0,transform:on?"scale(1.06)":"none",display:"inline-block"}}>{word}</span>})}</div>;
};

const Scene=({scene})=>{
  const frame=useCurrentFrame(),{durationInFrames,fps}=useVideoConfig(),fade=Math.min(12,Math.round(fps*.35));
  const opacity=scene.transition==="cut"?1:interpolate(frame,[0,fade,Math.max(fade+1,durationInFrames-fade),durationInFrames],[0,1,1,0],clamp);
  const enter=interpolate(frame,[0,fade],[0,1],clamp),transitionTransform=scene.transition==="slide"?`translateX(${(1-enter)*12}%)`:scene.transition==="zoom"?`scale(${.9+enter*.1})`:"none";
  return <AbsoluteFill style={{opacity,overflow:"hidden",background:"#111",transform:transitionTransform}}>
    <Img src={scene.imageUrl} style={{width:"100%",height:"100%",objectFit:"cover",transform:motionTransform(scene,frame,durationInFrames),transformOrigin:`${scene.focusX||50}% ${scene.focusY||50}%`}}/>
    {(scene.textLayers||[]).filter(layer=>layer.enabled!==false&&!["none","hidden"].includes(layer.animation)).map((layer,index)=><RichLayer key={layer.id||index} layer={layer} animation={layer.animation==="static"?"none":layer.animation||scene.textAnimation}/>)}
    {scene.subtitles&&(scene.showSlideTitle?scene.headline:scene.caption||scene.body)?<Caption text={scene.showSlideTitle?scene.headline:scene.caption||scene.body} style={scene.subtitleStyle} position={scene.subtitlePosition} font={scene.subtitleFont} color={scene.subtitleColor} backgroundColor={scene.subtitleBackgroundColor} backgroundOpacity={scene.subtitleBackgroundOpacity} size={scene.subtitleSize}/>:null}
  </AbsoluteFill>;
};

export const LanaVideo=({scenes=[],audioUrl="",audioVolume=.6,voiceUrl="",voiceVolume=1,voicePlaybackRate=1})=>{
  const {fps}=useVideoConfig();let cursor=0;
  return <AbsoluteFill style={{background:"#111"}}><VideoFonts/>{audioUrl?<Audio src={audioUrl} volume={audioVolume}/>:null}{voiceUrl?<Audio src={voiceUrl} volume={voiceVolume} playbackRate={voicePlaybackRate}/>:null}{scenes.filter(scene=>scene.enabled!==false).map(scene=>{const from=cursor;const frames=Math.max(fps,Math.round(scene.duration*fps));cursor+=frames;return <Sequence key={scene.id} from={from} durationInFrames={frames} premountFor={fps}><Scene scene={scene}/></Sequence>})}</AbsoluteFill>;
};

export const LanaVideoRoot=()=> <><Composition id="LanaCarouselVideo" component={LanaVideo} width={1080} height={1920} fps={30} durationInFrames={300} defaultProps={{scenes:[]}} calculateMetadata={({props})=>{const [width,height]=dims[props.aspectRatio]||dims.vertical;const fps=props.fps||30;const duration=(props.scenes||[]).filter(scene=>scene.enabled!==false).reduce((total,scene)=>total+Number(scene.duration||3),0);return{width,height,fps,durationInFrames:Math.max(fps,Math.ceil(duration*fps))}}}/><LanaAnalyzedVideoComposition/></>;
