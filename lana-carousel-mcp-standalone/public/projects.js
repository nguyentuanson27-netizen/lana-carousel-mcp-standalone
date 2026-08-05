const grid=document.getElementById("projectGrid");
const search=document.getElementById("search");
const resultCopy=document.getElementById("resultCopy");
const dialog=document.getElementById("createDialog");
const form=document.getElementById("createForm");
const projectType=document.getElementById("projectType");
const projectTitle=document.getElementById("projectTitle");
const topicField=document.getElementById("topicField");
const projectTopic=document.getElementById("projectTopic");
const videoUrlField=document.getElementById("videoUrlField");
const videoUrl=document.getElementById("videoUrl");
const dialogTitle=document.getElementById("dialogTitle");
const dialogDescription=document.getElementById("dialogDescription");
const formError=document.getElementById("formError");
const submitProject=document.getElementById("submitProject");
const toast=document.getElementById("toast");

const state={projects:[],filter:"all",query:"",loading:true};
const formatter=new Intl.DateTimeFormat("vi-VN",{day:"2-digit",month:"2-digit",year:"numeric"});
const relativeFormatter=new Intl.RelativeTimeFormat("vi",{numeric:"auto"});
let toastTimer;

const icons={
  image:'<svg width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5 18 4.5-4.5 3 3 2.5-2.5 4 4"/></svg>',
  video:'<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 10 4-2v8l-4-2z"/><path d="m8 9 4 3-4 3z"/></svg>',
  copy:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  clock:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  trash:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg>'
};

function escapeHtml(value=""){
  return String(value).replace(/[&<>"']/gu,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[character]);
}

function parseDate(value){
  if(!value)return null;
  const source=String(value).trim();
  const normalized=/Z$|[+-]\d\d:?\d\d$/u.test(source)?source:`${source.replace(" ","T")}Z`;
  const date=new Date(normalized);
  return Number.isNaN(date.getTime())?null:date;
}

function relativeDate(value){
  const date=parseDate(value);
  if(!date)return "Chưa rõ thời gian";
  const difference=date.getTime()-Date.now();
  const absolute=Math.abs(difference);
  if(absolute<60_000)return "Vừa cập nhật";
  const units=[
    ["year",31_536_000_000],
    ["month",2_592_000_000],
    ["day",86_400_000],
    ["hour",3_600_000],
    ["minute",60_000]
  ];
  const [unit,size]=units.find(([,amount])=>absolute>=amount)||units.at(-1);
  return relativeFormatter.format(Math.round(difference/size),unit);
}

function expiryCopy(value){
  const date=parseDate(value);
  return date?`Hết hạn ${formatter.format(date)}`:"Không có ngày hết hạn";
}

async function requestJson(url,options={}){
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.message||data.error||`Yêu cầu thất bại (${response.status})`);
  return data;
}

function imageStatus(project){
  if(project.imageStatus==="APPROVED")return{label:"Sẵn sàng",tone:"ready"};
  if(project.contentStatus==="APPROVED")return{label:"Đang chọn ảnh",tone:"editing"};
  return{label:"Bản nháp",tone:"draft"};
}

function videoStatus(project){
  if(project.status==="APPROVED")return{label:"Đã duyệt",tone:"ready"};
  if(project.source?.url)return{label:"Đang biên tập",tone:"editing"};
  return{label:"Chưa có video",tone:"draft"};
}

function videoDescription(project){
  if(project.source?.filename)return project.source.filename;
  if(project.script?.summary)return project.script.summary;
  return "Chưa gắn video nguồn";
}

function normalizeProjects(imageProjects,videoProjects){
  const images=(imageProjects||[]).map(project=>({
    id:project.id,
    type:"carousel",
    typeLabel:"Ảnh",
    title:project.title||"Dự án ảnh",
    description:project.topic||"Carousel và thiết kế hình ảnh",
    status:imageStatus(project),
    updatedAt:project.updatedAt||project.createdAt,
    createdAt:project.createdAt,
    expiresAt:project.expiresAt,
    openUrl:project.widgetUrl||`/widget?projectId=${encodeURIComponent(project.id)}`
  }));
  const videos=(videoProjects||[]).map(project=>({
    id:project.id,
    type:"video",
    typeLabel:"Video",
    title:project.title||"Dự án video",
    description:videoDescription(project),
    status:videoStatus(project),
    updatedAt:project.updatedAt||project.createdAt,
    createdAt:project.createdAt,
    expiresAt:project.expiresAt,
    openUrl:project.studioUrl||`/video-studio?projectId=${encodeURIComponent(project.id)}`
  }));
  return [...images,...videos].sort((left,right)=>(parseDate(right.updatedAt)?.getTime()||0)-(parseDate(left.updatedAt)?.getTime()||0));
}

function showToast(message){
  clearTimeout(toastTimer);
  toast.textContent=message;
  toast.classList.add("show");
  toastTimer=setTimeout(()=>toast.classList.remove("show"),2800);
}

function updateCounts(){
  document.getElementById("allCount").textContent=state.projects.length;
  document.getElementById("imageCount").textContent=state.projects.filter(project=>project.type==="carousel").length;
  document.getElementById("videoCount").textContent=state.projects.filter(project=>project.type==="video").length;
}

function filteredProjects(){
  const query=state.query.trim().toLocaleLowerCase("vi-VN");
  return state.projects.filter(project=>{
    const matchesType=state.filter==="all"||project.type===state.filter;
    const haystack=`${project.title} ${project.description} ${project.typeLabel}`.toLocaleLowerCase("vi-VN");
    return matchesType&&(!query||haystack.includes(query));
  });
}

function projectCard(project){
  const image=project.type==="carousel";
  const extraActions=image?`
    <button class="icon-btn" type="button" data-action="clone" data-id="${project.id}" aria-label="Nhân bản dự án" title="Nhân bản">${icons.copy}</button>
    <button class="icon-btn" type="button" data-action="extend" data-id="${project.id}" aria-label="Gia hạn 14 ngày" title="Gia hạn 14 ngày">${icons.clock}</button>`:"";
  return `<article class="project-card" data-project-id="${project.id}">
    <div class="project-thumb ${image?"image":"video"}" aria-hidden="true">${image?icons.image:icons.video}</div>
    <div class="project-main">
      <div class="project-top"><h3 class="project-title" title="${escapeHtml(project.title)}">${escapeHtml(project.title)}</h3><span class="type-badge ${image?"image":"video"}">${project.typeLabel}</span></div>
      <p class="project-description" title="${escapeHtml(project.description)}">${escapeHtml(project.description)}</p>
      <div class="project-meta"><span class="status-chip ${project.status.tone}">${project.status.label}</span><span title="${escapeHtml(expiryCopy(project.expiresAt))}">${escapeHtml(relativeDate(project.updatedAt))}</span><span>·</span><span>${escapeHtml(expiryCopy(project.expiresAt))}</span></div>
    </div>
    <div class="project-actions">
      <a class="btn small" href="${escapeHtml(project.openUrl)}">Mở ${image?"Carousel":"Video Studio"}</a>
      ${extraActions}
      <button class="icon-btn danger" type="button" data-action="delete" data-type="${project.type}" data-id="${project.id}" data-title="${escapeHtml(project.title)}" aria-label="Xóa dự án" title="Xóa">${icons.trash}</button>
    </div>
  </article>`;
}

function render(){
  if(state.loading)return;
  const projects=filteredProjects();
  resultCopy.textContent=projects.length===state.projects.length?`${projects.length} dự án`:`${projects.length} / ${state.projects.length} dự án`;
  if(!projects.length){
    const hasProjects=state.projects.length>0;
    grid.innerHTML=`<div class="empty"><div><div class="empty-icon">${hasProjects?icons.image:icons.video}</div><h3>${hasProjects?"Không tìm thấy dự án":"Workspace đang trống"}</h3><p>${hasProjects?"Thử đổi từ khóa hoặc bộ lọc để xem dự án khác.":"Tạo dự án ảnh hoặc video đầu tiên từ hai lựa chọn phía trên."}</p></div></div>`;
    return;
  }
  grid.innerHTML=projects.map(projectCard).join("");
}

async function loadProjects(){
  state.loading=true;
  resultCopy.textContent="Đang tải dự án…";
  const [imageResult,videoResult]=await Promise.allSettled([
    requestJson("/api/projects"),
    requestJson("/api/video-analysis/projects")
  ]);
  const imageProjects=imageResult.status==="fulfilled"?imageResult.value.projects:[];
  const videoProjects=videoResult.status==="fulfilled"?videoResult.value.projects:[];
  state.projects=normalizeProjects(imageProjects,videoProjects);
  state.loading=false;
  updateCounts();
  render();
  if(imageResult.status==="rejected"||videoResult.status==="rejected"){
    const failed=[];
    if(imageResult.status==="rejected")failed.push("dự án ảnh");
    if(videoResult.status==="rejected")failed.push("dự án video");
    showToast(`Không tải được ${failed.join(" và ")}.`);
  }
}

function openCreateDialog(type){
  const isVideo=type==="video";
  projectType.value=type;
  dialogTitle.textContent=isVideo?"Tạo dự án video":"Tạo dự án ảnh & carousel";
  dialogDescription.textContent=isVideo?"Mở Video Analysis Studio để gắn nguồn, chỉnh phụ đề và TTS.":"Mở Carousel Studio để xây nội dung theo slide và duyệt ảnh.";
  topicField.hidden=isVideo;
  videoUrlField.hidden=!isVideo;
  projectTitle.value="";
  projectTopic.value="";
  videoUrl.value="";
  formError.textContent="";
  submitProject.disabled=false;
  submitProject.textContent="Tạo và mở";
  dialog.showModal();
  requestAnimationFrame(()=>projectTitle.focus());
}

function closeCreateDialog(){
  if(dialog.open)dialog.close();
}

async function createProject(event){
  event.preventDefault();
  formError.textContent="";
  const type=projectType.value;
  const title=projectTitle.value.trim();
  if(!title){projectTitle.focus();return;}
  submitProject.disabled=true;
  submitProject.textContent="Đang tạo…";
  try{
    if(type==="video"){
      const sourceUrl=videoUrl.value.trim();
      const payload={title};
      if(sourceUrl){
        payload.sourceUrl=sourceUrl;
        try{payload.sourceFilename=new URL(sourceUrl).pathname.split("/").filter(Boolean).at(-1)||"video.mp4";}catch{payload.sourceFilename="video.mp4";}
      }
      const project=await requestJson("/api/video-analysis/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      location.href=project.studioUrl||`/video-studio?projectId=${encodeURIComponent(project.id)}`;
      return;
    }
    const project=await requestJson("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,topic:projectTopic.value.trim()})});
    location.href=project.widgetUrl||`/widget?projectId=${encodeURIComponent(project.id)}`;
  }catch(error){
    formError.textContent=error.message;
    submitProject.disabled=false;
    submitProject.textContent="Tạo và mở";
  }
}

async function handleProjectAction(button){
  const action=button.dataset.action;
  const id=button.dataset.id;
  if(!action||!id)return;
  button.disabled=true;
  try{
    if(action==="clone"){
      const project=await requestJson(`/api/projects/${encodeURIComponent(id)}/clone`,{method:"POST"});
      location.href=project.widgetUrl;
      return;
    }
    if(action==="extend"){
      await requestJson(`/api/projects/${encodeURIComponent(id)}/extend`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({days:14})});
      showToast("Đã gia hạn dự án thêm 14 ngày.");
      await loadProjects();
      return;
    }
    if(action==="delete"){
      const title=button.dataset.title||"dự án này";
      if(!confirm(`Xóa vĩnh viễn “${title}”?`)){button.disabled=false;return;}
      const endpoint=button.dataset.type==="video"?`/api/video-analysis/projects/${encodeURIComponent(id)}`:`/api/projects/${encodeURIComponent(id)}`;
      await requestJson(endpoint,{method:"DELETE"});
      state.projects=state.projects.filter(project=>project.id!==id);
      updateCounts();
      render();
      showToast("Đã xóa dự án.");
    }
  }catch(error){
    showToast(error.message);
    button.disabled=false;
  }
}

document.querySelectorAll("[data-create]").forEach(button=>button.addEventListener("click",()=>openCreateDialog(button.dataset.create)));
document.getElementById("newProjectBtn").addEventListener("click",()=>document.getElementById("create").scrollIntoView({behavior:"smooth",block:"center"}));
document.getElementById("closeDialog").addEventListener("click",closeCreateDialog);
document.getElementById("cancelDialog").addEventListener("click",closeCreateDialog);
dialog.addEventListener("click",event=>{if(event.target===dialog)closeCreateDialog();});
form.addEventListener("submit",createProject);
search.addEventListener("input",()=>{state.query=search.value;render();});
document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{
  state.filter=button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach(item=>{
    const active=item===button;
    item.classList.toggle("active",active);
    item.setAttribute("aria-selected",String(active));
  });
  render();
}));
grid.addEventListener("click",event=>{
  const button=event.target.closest("[data-action]");
  if(button)handleProjectAction(button);
});

loadProjects();
