import React from "react";
import {AbsoluteFill,Audio,Composition,OffthreadVideo,Sequence,interpolate,spring,useCurrentFrame,useVideoConfig} from "remotion";
import {VideoFonts} from "./fonts.jsx";

const FONT_STACKS={
 "TikTok Sans":"'TikTok Sans', Arial, Helvetica, sans-serif",
 Montserrat:"Montserrat, Arial, sans-serif",
 Poppins:"Poppins, Arial, sans-serif",
 Roboto:"Roboto, Arial, sans-serif",
 "Playfair Display":"'Playfair Display', Georgia, serif"
};

const splitWords=text=>String(text||"").trim().split(/\s+/u).filter(Boolean);
const KEYWORD_REGEX = /(freeship|miễn\s*phí\s*ship|cao\s*cấp|thêu\s*tay|chính\s*hãng|siêu\s*phẩm|giảm\s*giá|ưu\s*đãi|sale|\d+k|\d+tr|\d+%\b)/iu;

const hexAlpha = (hex = "#000000", opacity = 0.72) => {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${opacity})`;
};

const Caption = ({ segment, settings }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = String(segment.subtitleText || "");
  const words = text.split(/(\s+)/u);
  const wordParts = splitWords(text);

  // Word-level alignment: dựa trên mốc thời gian thực của từng từ
  let active = -1;
  const currentSec = frame / fps;
  if (segment.words && segment.words.length > 0) {
    active = segment.words.findIndex(w => currentSec >= w.start && currentSec < w.end);
    if (active === -1 && (segment.speechDuration || 0) > 0 && currentSec >= (segment.speechDuration || 0)) {
      active = segment.words.length - 1; // Giọng đọc kết thúc: giữ sáng từ cuối cùng
    }
  } else {
    const speechDur = Number(segment.speechDuration || 0) > 0 ? Number(segment.speechDuration) : Math.max(0.1, Number(segment.end) - Number(segment.start));
    const segmentFrames = Math.max(1, Math.round(speechDur * fps));
    active = Math.min(wordParts.length - 1, Math.floor((frame / segmentFrames) * wordParts.length));
  }

  const preset = settings.subtitlePreset || "tiktok-classic";
  const wordMode = settings.subtitleStyle === "word" || preset === "bounce-pop";
  let seen = -1;

  // Cấu hình các preset thịnh hành
  const isCapcutStroke = preset === "capcut-stroke";
  const isNeonGlow = preset === "neon-glow";
  const isBoxGradient = preset === "box-gradient";

  const defaultBg = hexAlpha(settings.subtitleBackgroundColor || "#000000", settings.subtitleBackgroundOpacity ?? 0.72);
  const background = isCapcutStroke
    ? "transparent"
    : isBoxGradient
    ? "linear-gradient(135deg, rgba(20,20,35,0.88) 0%, rgba(45,30,50,0.88) 100%)"
    : isNeonGlow
    ? "rgba(10, 10, 15, 0.65)"
    : defaultBg;

  const border = isBoxGradient ? "2px solid rgba(255,255,255,0.25)" : undefined;
  const textShadow = isCapcutStroke
    ? "0 4px 14px rgba(0,0,0,0.95)"
    : isNeonGlow
    ? "0 0 10px #FF007F, 0 0 22px #FF007F"
    : "0 2px 8px rgba(0,0,0,0.6)";

  const strokeStyle = isCapcutStroke
    ? { WebkitTextStroke: "3.5px #000000", paintOrder: "stroke fill" }
    : {};

  const activeColor = isCapcutStroke
    ? "#00F2FE"
    : isNeonGlow
    ? "#FFFC00"
    : "#FFE600";

  return (
    <div
      style={{
        position: "absolute",
        left: `${settings.subtitleX ?? 50}%`,
        top: `${settings.subtitlePosition ?? 86}%`,
        transform: "translate(-50%, -50%)",
        width: wordMode ? "auto" : "88%",
        minWidth: wordMode ? 180 : undefined,
        maxWidth: "94%",
        textAlign: "center",
        fontFamily: FONT_STACKS[settings.subtitleFont] || settings.subtitleFont || FONT_STACKS["TikTok Sans"],
        fontSize: settings.subtitleSize || 52,
        fontWeight: 800,
        lineHeight: 1.22,
        color: settings.subtitleColor || "#fff",
        background,
        border,
        textShadow,
        ...strokeStyle,
        padding: "16px 24px",
        borderRadius: 20,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        zIndex: 10
      }}
    >
      {wordMode ? (
        <span
          style={{
            display: "inline-block",
            transform: "scale(1.12)",
            color: activeColor
          }}
        >
          {wordParts[Math.max(0, active)] || ""}
        </span>
      ) : (
        words.map((word, index) => {
          if (word.trim()) seen++;
          const isWordActive = settings.subtitleStyle === "karaoke" && seen === active;
          const isKeyword = KEYWORD_REGEX.test(word);

          let wordColor = undefined;
          if (isWordActive) {
            wordColor = isKeyword ? "#FF4D4F" : activeColor;
          } else if (isKeyword) {
            wordColor = "#FFDF70";
          }

          return (
            <span
              key={index}
              style={{
                color: wordColor,
                display: isWordActive && preset === "bounce-pop" ? "inline-block" : undefined,
                transform: isWordActive && preset === "bounce-pop" ? "scale(1.18)" : undefined,
                transition: "transform 0.1s ease"
              }}
            >
              {word}
            </span>
          );
        })
      )}
    </div>
  );
};

// Sticker & CTA động (Giỏ hàng TikTok Shop, Khuyến mãi, Follow)
const AnimatedCtaOverlay = ({ settings, totalFrames, fps }) => {
  if (!settings?.ctaEnabled) return null;
  const frame = useCurrentFrame();

  // CTA xuất hiện ở 4.5 giây cuối cùng của video
  const ctaDurationFrames = Math.round(4.5 * fps);
  const startFrame = Math.max(0, totalFrames - ctaDurationFrames);
  if (frame < startFrame) return null;

  const activeFrame = frame - startFrame;
  const entrance = spring({ frame: activeFrame, fps, config: { damping: 14, stiffness: 180 } });
  const pulse = Math.sin(activeFrame * 0.18);
  const arrowBounce = Math.sin(activeFrame * 0.25) * 6;

  const type = settings.ctaType || "cart";
  const pos = settings.ctaPosition || "bottom-left";
  const text = settings.ctaText || (
    type === "cart" ? "Nhấp góc trái để mua ngay 👇" :
    type === "sale-badge" ? "HOT SALE • FREESHIP" :
    "Follow để xem thêm mẫu mới ❤️"
  );

  let positionStyle = {
    position: "absolute",
    left: "50%",
    bottom: 260,
    transform: `translateX(-50%) scale(${entrance})`,
    zIndex: 20
  };

  if (pos === "bottom-left") {
    positionStyle = {
      position: "absolute",
      left: 60,
      bottom: 280,
      transform: `scale(${entrance})`,
      transformOrigin: "bottom left",
      zIndex: 20
    };
  } else if (pos === "top-right") {
    positionStyle = {
      position: "absolute",
      right: 60,
      top: 140,
      transform: `scale(${entrance * (1 + pulse * 0.04)})`,
      transformOrigin: "top right",
      zIndex: 20
    };
  }

  if (type === "cart") {
    return (
      <div style={{
        ...positionStyle,
        display: "flex",
        alignItems: "center",
        gap: 14,
        background: "linear-gradient(135deg, #FE2C55 0%, #FF0050 100%)",
        boxShadow: "0 8px 24px rgba(254,44,85,0.45), 0 2px 8px rgba(0,0,0,0.4)",
        padding: "16px 26px",
        borderRadius: 40,
        color: "#fff",
        fontFamily: "'TikTok Sans', sans-serif",
        fontSize: 34,
        fontWeight: 800,
        border: "2px solid rgba(255,255,255,0.3)"
      }}>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="#FFE600">
          <path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49c.08-.14.12-.31.12-.48 0-.55-.45-1-1-1H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/>
        </svg>
        <span>{text}</span>
        <span style={{ display: "inline-block", transform: `translateY(${arrowBounce}px)` }}>👇</span>
      </div>
    );
  }

  if (type === "sale-badge") {
    return (
      <div style={{
        ...positionStyle,
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "linear-gradient(135deg, #FF6B00 0%, #FFA800 100%)",
        boxShadow: "0 8px 24px rgba(255,107,0,0.5)",
        padding: "14px 28px",
        borderRadius: 30,
        color: "#fff",
        fontFamily: "'TikTok Sans', sans-serif",
        fontSize: 32,
        fontWeight: 900,
        letterSpacing: "0.5px",
        border: "2px solid #FFF"
      }}>
        <span style={{ fontSize: 36 }}>🔥</span>
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div style={{
      ...positionStyle,
      display: "flex",
      alignItems: "center",
      gap: 14,
      background: "rgba(0,0,0,0.82)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
      padding: "16px 32px",
      borderRadius: 40,
      color: "#fff",
      fontFamily: "'TikTok Sans', sans-serif",
      fontSize: 34,
      fontWeight: 700,
      border: "2px solid #FE2C55"
    }}>
      <span style={{ display: "inline-block", transform: `scale(${1 + pulse * 0.12})` }}>❤️</span>
      <span>{text}</span>
    </div>
  );
};

// Mỗi đoạn có clip giọng đọc riêng đặt đúng mốc `start`, nên tiếng và phụ đề không lệch dần.
const VoiceTrack=({track,settings})=>{
 const {fps}=useVideoConfig();
 const trimmed=track.measured!==false&&Number(track.duration)>0;
 return <Sequence from={Math.round(Number(track.start||0)*fps)} durationInFrames={trimmed?Math.max(1,Math.ceil(Number(track.duration)*fps)):undefined}>
  <Audio src={track.url} volume={settings.ttsVolume??1} playbackRate={Number(track.playbackRate)||1}/>
 </Sequence>;
};

const AnalyzedVideo=({sourceVideoUrl,segments=[],settings={},voiceTracks=[],sfxUrls={}})=>{
 const {fps,durationInFrames}=useVideoConfig();
 const sfxVolume = settings.sfxVolume ?? 0.25;
 const ctaStartFrame = settings.ctaEnabled ? Math.max(0, durationInFrames - Math.round(4.5 * fps)) : 0;

 return (
  <AbsoluteFill style={{background:"#000"}}>
    <VideoFonts/>
    <OffthreadVideo src={sourceVideoUrl} volume={settings.originalAudioVolume??.25}/>
    
    {/* Voice-over tracks */}
    {voiceTracks.filter(track=>track&&track.url).map((track,index)=><VoiceTrack key={track.id||index} track={track} settings={settings}/>)}

    {/* SFX: Whoosh chuyển cảnh giữa các phân đoạn */}
    {settings.sfxEnabled !== false && sfxUrls?.whoosh ? segments.map((segment, index) => {
      if (index === 0 || segment.enabled === false) return null;
      return (
        <Sequence key={`sfx-whoosh-${segment.id || index}`} from={Math.round(Number(segment.start || 0) * fps)} durationInFrames={12}>
          <Audio src={sfxUrls.whoosh} volume={sfxVolume} />
        </Sequence>
      );
    }) : null}

    {/* SFX: Ding khi CTA xuất hiện */}
    {settings.sfxEnabled !== false && settings.ctaEnabled && sfxUrls?.ding ? (
      <Sequence from={ctaStartFrame} durationInFrames={15}>
        <Audio src={sfxUrls.ding} volume={sfxVolume} />
      </Sequence>
    ) : null}

    {/* Subtitles with Word-level Alignment & Presets */}
    {settings.subtitleEnabled!==false?segments.filter(segment=>segment.enabled!==false).map(segment=>(
      <Sequence key={segment.id} from={Math.round(Number(segment.start||0)*fps)} durationInFrames={Math.max(1,Math.round((Number(segment.end)-Number(segment.start))*fps))}>
        <Caption segment={segment} settings={settings}/>
      </Sequence>
    )):null}

    {/* Animated Sticker / Call-To-Action (CTA) Overlay */}
    <AnimatedCtaOverlay settings={settings} totalFrames={durationInFrames} fps={fps} />
  </AbsoluteFill>
 );
};

export const LanaAnalyzedVideoComposition=()=> <Composition id="LanaAnalyzedVideo" component={AnalyzedVideo} width={1080} height={1920} fps={30} durationInFrames={300} defaultProps={{sourceVideoUrl:"",sourceDuration:0,voiceDuration:0,segments:[],settings:{},voiceTracks:[],sfxUrls:{}}} calculateMetadata={({props})=>{const fps=30,d=Math.max(Number(props?.sourceDuration||0),Number(props?.voiceDuration||0),...(props?.segments||[]).map(segment=>Number(segment.end||0)),1);return{fps,durationInFrames:Math.ceil(d*fps)}}}/>;
