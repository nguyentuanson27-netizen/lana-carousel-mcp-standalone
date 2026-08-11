import React from "react";
import {continueRender,delayRender,staticFile} from "remotion";

// Chữ trong composition được Chromium vẽ trực tiếp, không đi qua renderer ảnh của src/fonts.js.
// Nếu không nạp @font-face ở đây thì mọi font thiết kế đều rơi về font mặc định của Chromium
// và bản MP4 không còn khớp với preview trong studio.
const FACES=[
 {family:"TikTok Sans",file:"fonts/TikTokSans-Variable.ttf",format:"truetype-variations",weight:"100 900"},
 {family:"Montserrat",file:"fonts/Montserrat-Variable.ttf",format:"truetype-variations",weight:"100 900"},
 {family:"Playfair Display",file:"fonts/PlayfairDisplay-Variable.ttf",format:"truetype-variations",weight:"400 900"},
 {family:"Roboto",file:"fonts/Roboto-Variable.ttf",format:"truetype-variations",weight:"100 900"},
 {family:"Bebas Neue",file:"fonts/BebasNeue-Regular.ttf",format:"truetype",weight:"400"},
 {family:"Poppins",file:"fonts/Poppins-Regular.ttf",format:"truetype",weight:"400"},
 {family:"Poppins",file:"fonts/Poppins-Medium.ttf",format:"truetype",weight:"500"},
 {family:"Poppins",file:"fonts/Poppins-SemiBold.ttf",format:"truetype",weight:"600"},
 {family:"Poppins",file:"fonts/Poppins-Bold.ttf",format:"truetype",weight:"700"},
 {family:"Poppins",file:"fonts/Poppins-ExtraBold.ttf",format:"truetype",weight:"800"},
 {family:"Poppins",file:"fonts/Poppins-Black.ttf",format:"truetype",weight:"900"},
 {family:"Courier New",file:"fonts/CourierPrime-Regular.ttf",format:"truetype",weight:"400"},
 {family:"Courier New",file:"fonts/CourierPrime-Bold.ttf",format:"truetype",weight:"700"},
 {family:"Courier Prime",file:"fonts/CourierPrime-Regular.ttf",format:"truetype",weight:"400"},
 {family:"Courier Prime",file:"fonts/CourierPrime-Bold.ttf",format:"truetype",weight:"700"}
];

const faceCss=face=>`@font-face{font-family:"${face.family}";src:url("${staticFile(face.file)}") format("${face.format}");font-weight:${face.weight};font-display:block}`;

export const VideoFonts=()=>{
 const [handle]=React.useState(()=>delayRender("Nạp font cho video"));
 React.useEffect(()=>{
  let cancelled=false;
  const release=()=>{if(!cancelled)continueRender(handle)};
  // Mỗi face phải được yêu cầu tường minh, `document.fonts.ready` không tự tải font chưa dùng tới.
  Promise.all(FACES.map(face=>document.fonts.load(`${face.weight.split(" ")[0]} 64px "${face.family}"`).catch(()=>undefined)))
   .then(()=>document.fonts.ready)
   .then(release,release);
  return()=>{cancelled=true};
 },[handle]);
 return <style>{FACES.map(faceCss).join("")}</style>;
};
