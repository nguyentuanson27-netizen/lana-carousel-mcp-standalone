export async function loadUnifiedProjectSources(requestJson){
 const [imageResult,videoResult]=await Promise.allSettled([
  requestJson("/api/projects"),
  requestJson("/api/video-analysis/projects")
 ]);
 const sources={
  carousel:imageResult.status==="fulfilled"?"ready":"error",
  video:videoResult.status==="fulfilled"?"ready":"error"
 };
 const failures=[];
 if(imageResult.status==="rejected")failures.push({type:"carousel",label:"dự án ảnh",message:imageResult.reason?.message||"Không tải được dự án ảnh."});
 if(videoResult.status==="rejected")failures.push({type:"video",label:"dự án video",message:videoResult.reason?.message||"Không tải được dự án video."});
 return{
  imageProjects:imageResult.status==="fulfilled"?imageResult.value.projects||[]:[],
  videoProjects:videoResult.status==="fulfilled"?videoResult.value.projects||[]:[],
  sources,
  failures,
  successCount:Number(sources.carousel==="ready")+Number(sources.video==="ready")
 };
}

function sourceFilenameFromUrl(sourceUrl){
 try{return new URL(sourceUrl).pathname.split("/").filter(Boolean).at(-1)||"video.mp4"}
 catch{return"video.mp4"}
}

export async function createDashboardProject({type,title,topic="",sourceUrl="",requestJson}){
 if(type==="video"){
  const payload={title};
  if(sourceUrl){payload.sourceUrl=sourceUrl;payload.sourceFilename=sourceFilenameFromUrl(sourceUrl);}
  return requestJson("/api/video-analysis/projects",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify(payload)
  });
 }
 return requestJson("/api/projects",{
  method:"POST",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify({title,topic})
 });
}

export function projectDeleteEndpoint(type,id){
 const encoded=encodeURIComponent(id);
 return type==="video"?`/api/video-analysis/projects/${encoded}`:`/api/projects/${encoded}`;
}
