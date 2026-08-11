import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {fileTypeFromFile} from "file-type";
import {config} from "./config.js";
import {AppError} from "./errors.js";
import {parseRemoteUrl,resolvePublicHost} from "./ssrf.js";

const allowedTypes=new Set(["video/mp4","video/webm","video/quicktime"]);
const looseTypes=new Set(["", "application/octet-stream", "binary/octet-stream"]);
const extensionByMime={"video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov"};
const assetDirectory=path.resolve(path.dirname(config.databasePath),"video-analysis-assets");

await fsp.mkdir(assetDirectory,{recursive:true});

function responseContentType(headers){
 const raw=Array.isArray(headers["content-type"])?headers["content-type"][0]:headers["content-type"];
 return String(raw||"").split(";")[0].trim().toLowerCase();
}

function safeDisplayFilename(value,fallback){
 const raw=path.basename(String(value||fallback||"video.mp4")).normalize("NFKC");
 const cleaned=raw.replace(/[^\p{L}\p{N}._ -]+/gu,"_").trim().slice(0,180);
 return cleaned||fallback||"video.mp4";
}

function managedAssetName(rawUrl){
 let url;
 let base;
 try{
  url=new URL(rawUrl);
  base=new URL(config.publicBaseUrl);
 }catch{return null}
 if(url.origin!==base.origin||!url.pathname.startsWith("/video-analysis-assets/"))return null;
 const encoded=url.pathname.slice("/video-analysis-assets/".length);
 if(!encoded||encoded.includes("/"))return null;
 let decoded;
 try{decoded=decodeURIComponent(encoded)}catch{return null}
 if(path.basename(decoded)!==decoded||decoded.startsWith("."))return null;
 return decoded;
}

export function isManagedVideoSourceUrl(rawUrl){
 return Boolean(managedAssetName(rawUrl));
}

// Không đo được độ dài video nguồn thì composition chỉ dài bằng segment cuối cùng,
// nên phần video sau câu phụ đề cuối bị cắt mất khi render.
export async function probeVideoDurationSeconds(absolutePath){
 if(!absolutePath)return 0;
 try{
  const {getVideoMetadata}=await import("@remotion/renderer");
  const metadata=await getVideoMetadata(absolutePath);
  const duration=Number(metadata?.durationInSeconds||0);
  return Number.isFinite(duration)&&duration>0?duration:0;
 }catch{
  return 0;
 }
}

export function assertManagedVideoSourceUrl(rawUrl){
 if(!isManagedVideoSourceUrl(rawUrl)){
  throw new AppError(
   "UNSAFE_VIDEO_SOURCE",
   "Video nguồn phải được nhập qua downloader an toàn và lưu thành asset nội bộ trước khi render.",
   422
  );
 }
 return String(rawUrl);
}

export async function deleteManagedVideoSource(rawUrl){
 const name=managedAssetName(rawUrl);
 if(!name)return false;
 await fsp.unlink(path.join(assetDirectory,name)).catch(()=>{});
 return true;
}

function requestOnce(url,tempPath){
 return resolvePublicHost(url.hostname).then(targets=>new Promise((resolve,reject)=>{
  const client=url.protocol==="https:"?https:http;
  let settled=false;
  const finish=(handler,value)=>{
   if(settled)return;
   settled=true;
   handler(value);
  };
  const req=client.request({
   protocol:url.protocol,
   hostname:url.hostname,
   port:url.port||undefined,
   path:`${url.pathname}${url.search}`,
   method:"GET",
   servername:url.hostname,
   headers:{
    "User-Agent":"Mozilla/5.0 (compatible; LanaVideoImporter/1.0; +https://content.lanadesign.tech)",
    "Accept":"video/mp4,video/webm,video/quicktime,application/octet-stream;q=0.6",
    "Accept-Encoding":"identity"
   },
   lookup:(_hostname,options,callback)=>{
    if(options?.all){callback(null,targets);return;}
    callback(null,targets[0].address,targets[0].family);
   }
  },res=>{
   const status=res.statusCode||0;
   const headers=res.headers;
   if(status>=300&&status<400&&headers.location){
    res.resume();
    finish(resolve,{status,headers,size:0,contentType:""});
    return;
   }
   if(status<200||status>=300){
    res.resume();
    finish(resolve,{status,headers,size:0,contentType:""});
    return;
   }

   const declared=Number(headers["content-length"]||0);
   if(declared>config.maxRemoteVideoBytes){
    res.destroy();
    finish(reject,new AppError("VIDEO_FILE_TOO_LARGE","Video vượt quá dung lượng cho phép.",413));
    return;
   }
   const contentType=responseContentType(headers);
   if(!allowedTypes.has(contentType)&&!looseTypes.has(contentType)){
    res.destroy();
    finish(reject,new AppError("UNSUPPORTED_VIDEO_TYPE",`Không hỗ trợ ${contentType||"unknown"}.`,415));
    return;
   }

   let total=0;
   const output=fs.createWriteStream(tempPath,{flags:"wx"});
   const fail=error=>{
    res.destroy();
    output.destroy();
    finish(reject,error instanceof AppError?error:new AppError("REMOTE_VIDEO_FAILED","Không tải được video từ nguồn này.",422));
   };
   res.on("data",chunk=>{
    total+=chunk.length;
    if(total>config.maxRemoteVideoBytes){
     fail(new AppError("VIDEO_FILE_TOO_LARGE","Video vượt quá dung lượng cho phép.",413));
    }
   });
   res.on("error",fail);
   output.on("error",fail);
   output.on("finish",()=>finish(resolve,{status,headers,size:total,contentType}));
   res.pipe(output);
  });

  req.setTimeout(config.videoSourceTimeoutMs,()=>{
   req.destroy(new AppError("REMOTE_VIDEO_TIMEOUT","Nguồn video phản hồi quá chậm.",504));
  });
  req.on("error",error=>{
   finish(reject,error instanceof AppError?error:new AppError("REMOTE_VIDEO_FAILED","Không tải được video từ nguồn này.",422));
  });
  req.end();
 }));
}

export async function importRemoteVideoSource({url:rawUrl,filename="video.mp4"}){
 let url=parseRemoteUrl(rawUrl);
 const tempPath=path.join(assetDirectory,`.remote-${randomUUID()}.part`);
 try{
  let response;
  for(let redirect=0;;redirect+=1){
   response=await requestOnce(url,tempPath);
   if(response.status>=300&&response.status<400&&response.headers.location){
    if(redirect>=config.maxRedirects){
     throw new AppError("TOO_MANY_REDIRECTS","Nguồn video chuyển hướng quá nhiều lần.",422);
    }
    url=parseRemoteUrl(new URL(response.headers.location,url).toString());
    continue;
   }
   if([401,403].includes(response.status))throw new AppError("REMOTE_VIDEO_BLOCKED","Nguồn video chặn tải trực tiếp.",422);
   if(response.status===404)throw new AppError("REMOTE_VIDEO_NOT_FOUND","Không tìm thấy video.",404);
   if(response.status<200||response.status>=300){
    throw new AppError("REMOTE_VIDEO_FAILED",`Nguồn video trả HTTP ${response.status}.`,422);
   }
   break;
  }

  const detected=await fileTypeFromFile(tempPath);
  if(!detected||!allowedTypes.has(detected.mime)){
   throw new AppError("INVALID_VIDEO_FILE","File tải về không phải video MP4, WebM hoặc MOV hợp lệ.",415);
  }
  const extension=extensionByMime[detected.mime];
  const storedName=`${randomUUID()}.${extension}`;
  const absolutePath=path.join(assetDirectory,storedName);
  await fsp.rename(tempPath,absolutePath);
  const fallbackName=`video.${extension}`;
  return{
   url:`${config.publicBaseUrl}/video-analysis-assets/${encodeURIComponent(storedName)}`,
   filename:safeDisplayFilename(filename||path.basename(url.pathname),fallbackName),
   mime:detected.mime,
   size:response.size,
   duration:await probeVideoDurationSeconds(absolutePath),
   absolutePath,
   finalRemoteUrl:url.toString()
  };
 }catch(error){
  await fsp.unlink(tempPath).catch(()=>{});
  throw error;
 }
}
