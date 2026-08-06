(async()=>{
 const {
  createDashboardProject,
  loadUnifiedProjectSources,
  projectDeleteEndpoint
 }=await import("/projects-api.js");

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

 document.head.insertAdjacentHTML("beforeend",`<style>
  .load-warning{grid-column:1/-1;display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:16px 18px;border:1px solid #e4c996;border-radius:17px;background:#fff7e8;color:#6f4f24}
  .load-warning span{display:grid;place-items:center}.load-warning p{margin:3px 0 0;color:#846943;font-size:13px}
  .error-state .empty-icon{background:#fff0ef;color:#a03935}.error-state .btn{margin-top:18px}
  @media(max-width:620px){.load-warning{grid-template-columns:auto 1fr}.load-warning .btn{grid-column:1/-1}}
 </style>`);

 const state={
  projects:[],
  filter:"all",
  query:"",
  loading:true,
  sources:{carousel:"pending",video:"pending"},
  failures:[]
 };
 const formatter=new Intl.DateTimeFormat("vi-VN",{day:"2-digit",month:"2-digit",year:"numeric"});
 const relativeFormatter=new Intl.RelativeTimeFormat("vi",{numeric:"auto"});
 let toastTimer;

 const icons={
  image:'<svg width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5 18 4.5-4.5 3 3 2.5-2.5 4 4"/></svg>',
  video:'<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 10 4-2v8l-4-2z"/><path d="m8 9 4 3-4 3z"/></svg>',
  copy:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  clock:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  trash:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg>',
  warning:'<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/></svg>'
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
  if(!date)return"Chưa rõ thời gian";
  const difference=date.getTime()-Date.now();
  const absolute=Math.abs(difference);
  if(absolute<60_000)return"Vừa cập nhật";
  const units=[["year",31_536_000_000],["month",2_592_000_000],["day",86_400_000],["hour",3_600_000],["minute",60_000]];
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

 function normalizeProjects(imageProjects,videoProjects){
  const images=imageProjects.map(project=>({
   id:project.id,type:"carousel",typeLabel:"Ảnh",title:project.title||"Dự án ảnh",
   description:project.topic||"Carousel và thiết kế hình ảnh",status:imageStatus(project),
   updatedAt:project.updatedAt||project.createdAt,createdAt:project.createdAt,expiresAt:project.expiresAt,
   openUrl:project.widgetUrl||`/widget?projectId=${encodeURIComponent(project.id)}`
  }));
  const videos=videoProjects.map(project=>({
   id:project.id,type:"video",typeLabel:"Video",title:project.title||"Dự án video",
   description:project.source?.filename||project.script?.summary||"Chưa gắn video nguồn",status:videoStatus(project),
   updatedAt:project.updatedAt||project.createdAt,createdAt:project.createdAt,expiresAt:project.expiresAt,
   openUrl:project.studioUrl||`/video-studio?projectId=${encodeURIComponent(project.id)}`
  }));
  return[...images,...videos].sort((left,right)=>(parseDate(right.updatedAt)?.getTime()||0)-(parseDate(left.updatedAt)?.getTime()||0));
 }

 function showToast(message){
  clearTimeout(toastTimer);
  toast.textContent=message;
  toast.classList.add("show");
  toastTimer=setTimeout(()=>toast.classList.remove("show"),3200);
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
   <button class="icon-btn" type="button" data-action="clone" data-id="${project.id}" aria-label="Nhân bản" title="Nhân bản">${icons.copy}</button>
   <button class="icon-btn" type="button" data-action="extend" data-id="${project.id}" aria-label="Gia hạn" title="Gia hạn 14 ngày">${icons.clock}</button>`:"";
  return `<article class="project-card">
   <div class="project-thumb ${image?"image":"video"}" aria-hidden="true">${image?icons.image:icons.video}</div>
   <div class="project-main">
    <div class="project-top"><h3 class="project-title">${escapeHtml(project.title)}</h3><span class="type-badge ${image?"image":"video"}">${project.typeLabel}</span></div>
    <p class="project-description">${escapeHtml(project.description)}</p>
    <div class="project-meta"><span class="status-chip ${project.status.tone}">${project.status.label}</span><span>${escapeHtml(relativeDate(project.updatedAt))}</span><span>·</span><span>${escapeHtml(expiryCopy(project.expiresAt))}</span></div>
   </div>
   <div class="project-actions">
    <a class="btn small" href="${escapeHtml(project.openUrl)}">Mở ${image?"Carousel":"Video Studio"}</a>
    ${extraActions}
    <button class="icon-btn danger" type="button" data-action="delete" data-type="${project.type}" data-id="${project.id}" data-title="${escapeHtml(project.title)}" aria-label="Xóa" title="Xóa">${icons.trash}</button>
   </div>
  </article>`;
 }

 function persistentFailureNotice(){
  if(!state.failures.length)return"";
  const missing=state.failures.map(item=>item.label).join(" và ");
  return `<div class="load-warning" role="status">
   <span>${icons.warning}</span>
   <div><strong>Danh sách chưa đầy đủ</strong><p>Không tải được ${escapeHtml(missing)}. Những dự án đang hiển thị đến từ nguồn còn hoạt động.</p></div>
   <button class="btn secondary small" data-action="retry" type="button">Thử lại</button>
  </div>`;
 }

 function render(){
  if(state.loading)return;
  if(state.failures.length===2){
   resultCopy.textContent="Không thể tải workspace";
   grid.innerHTML=`<div class="empty error-state" role="alert"><div><div class="empty-icon">${icons.warning}</div><h3>Không thể tải dự án</h3><p>Cả dịch vụ ảnh và video đều không phản hồi. Dữ liệu chưa được xác nhận là trống.</p><button class="btn" data-action="retry" type="button">Thử lại</button></div></div>`;
   return;
  }
  const projects=filteredProjects();
  const warning=persistentFailureNotice();
  resultCopy.textContent=projects.length===state.projects.length?`${projects.length} dự án`:`${projects.length} / ${state.projects.length} dự án`;
  if(!projects.length){
   const hasProjects=state.projects.length>0;
   grid.innerHTML=`${warning}<div class="empty"><div><div class="empty-icon">${hasProjects?icons.image:icons.video}</div><h3>${hasProjects?"Không tìm thấy dự án":"Workspace đang trống"}</h3><p>${hasProjects?"Thử đổi từ khóa hoặc bộ lọc.":"Ít nhất một dịch vụ đã tải thành công và chưa có dự án nào."}</p></div></div>`;
   return;
  }
  grid.innerHTML=warning+projects.map(projectCard).join("");
 }

 async function loadProjects(){
  state.loading=true;
  state.failures=[];
  resultCopy.textContent="Đang tải dự án…";
  grid.innerHTML='<div class="loading-state"><div class="skeleton"><div class="skeleton-card"></div><div class="skeleton-card"></div></div></div>';
  try{
   const loaded=await loadUnifiedProjectSources(requestJson);
   state.sources=loaded.sources;
   state.failures=loaded.failures;
   state.projects=normalizeProjects(loaded.imageProjects,loaded.videoProjects);
  }catch(error){
   state.sources={carousel:"error",video:"error"};
   state.failures=[{label:"dự án ảnh"},{label:"dự án video"}];
   state.projects=[];
   showToast(error.message);
  }
  state.loading=false;
  updateCounts();
  render();
 }

 function openCreateDialog(type){
  const isVideo=type==="video";
  projectType.value=type;
  dialogTitle.textContent=isVideo?"Tạo dự án video":"Tạo dự án ảnh & carousel";
  dialogDescription.textContent=isVideo?"URL HTTPS sẽ được tải về qua lớp bảo vệ SSRF trước khi mở Video Studio.":"Tạo workspace thiết kế ảnh và carousel.";
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

 function closeCreateDialog(){if(dialog.open)dialog.close();}

 async function createProject(event){
  event.preventDefault();
  formError.textContent="";
  const type=projectType.value;
  const title=projectTitle.value.trim();
  const sourceUrl=videoUrl.value.trim();
  if(!title){projectTitle.focus();return;}
  if(type==="video"&&sourceUrl){
   try{if(new URL(sourceUrl).protocol!=="https:")throw new Error();}
   catch{formError.textContent="Video từ xa phải dùng URL HTTPS hợp lệ.";videoUrl.focus();return;}
  }
  submitProject.disabled=true;
  submitProject.textContent="Đang tạo…";
  try{
   const project=await createDashboardProject({type,title,topic:projectTopic.value.trim(),sourceUrl,requestJson});
   location.href=type==="video"
    ?project.studioUrl||`/video-studio?projectId=${encodeURIComponent(project.id)}`
    :project.widgetUrl||`/widget?projectId=${encodeURIComponent(project.id)}`;
  }catch(error){
   formError.textContent=error.message;
   submitProject.disabled=false;
   submitProject.textContent="Tạo và mở";
  }
 }

 async function handleProjectAction(button){
  const action=button.dataset.action;
  if(action==="retry"){button.disabled=true;await loadProjects();return;}
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
    await requestJson(projectDeleteEndpoint(button.dataset.type,id),{method:"DELETE"});
    state.projects=state.projects.filter(project=>project.id!==id);
    updateCounts();
    render();
    showToast("Đã xóa dự án và dọn các file render liên quan.");
   }
  }catch(error){showToast(error.message);button.disabled=false;}
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

 await loadProjects();
})().catch(error=>{
 const grid=document.getElementById("projectGrid");
 const resultCopy=document.getElementById("resultCopy");
 if(resultCopy)resultCopy.textContent="Không thể khởi tạo workspace";
 if(grid)grid.innerHTML=`<div class="empty error-state" role="alert"><div><h3>Không thể mở trang dự án</h3><p>${String(error?.message||error)}</p><button class="btn" type="button" onclick="location.reload()">Tải lại trang</button></div></div>`;
 console.error("Unified dashboard failed",error);
});
