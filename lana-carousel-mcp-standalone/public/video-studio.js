const $=selector=>document.querySelector(selector);
const params=new URLSearchParams(location.search);
let projectId=params.get("projectId"),project,jobTimer,jobPollGeneration=0,dragging=false;

const FONT_STACKS={
  "TikTok Sans":"'TikTok Sans', Arial, Helvetica, sans-serif",
  Montserrat:"Montserrat, Arial, sans-serif",
  Poppins:"Poppins, Arial, sans-serif",
  Roboto:"Roboto, Arial, sans-serif",
  "Playfair Display":"'Playfair Display', Georgia, serif"
};
const RANGE_OUTPUTS={
  ttsSpeed:value=>`${Number(value).toFixed(2)}×`,
  originalVolume:value=>`${Math.round(Number(value)*100)}%`,
  ttsVolume:value=>`${Math.round(Number(value)*100)}%`,
  subtitleSize:value=>`${Math.round(Number(value))} px`,
  subtitleOpacity:value=>`${Math.round(Number(value)*100)}%`,
  subtitleX:value=>`${Math.round(Number(value))}%`,
  subtitlePosition:value=>`${Math.round(Number(value))}%`,
  sfxVolume:value=>`${Math.round(Number(value)*100)}%`
};
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const api=async(url,opt={})=>{const response=await fetch(url,opt),json=await response.json().catch(()=>({}));if(!response.ok)throw new Error(json.message||json.error||"Yêu cầu thất bại");return json};

async function ensure(){
  if(projectId)return load();
  const title=prompt("Tên dự án video","Video mới");
  if(!title)return;
  const created=await api("/api/video-analysis/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title})});
  location.href=created.studioUrl;
}

const settings=()=>({
  ttsEnabled:$("#ttsEnabled").checked,
  ttsProvider:$("#ttsProvider").value,
  ttsSpeed:+$("#ttsSpeed").value,
  geminiSpeaker1Voice:$("#voice").value,
  // Giữ voice theo từng provider độc lập. `ttsVoice` thuộc Google; Lucylab có field riêng.
  // Nếu ghi Lucylab ID vào `ttsVoice`, lần reload rồi đổi sang Google sẽ lộ đúng ID sai hệ đó.
  ttsVoice:$("#googleVoice").value,
  lucylabVoice:$("#lucylabVoice")?.value||"vcXEe1p3FxPfpswf3BhwbG",
  originalAudioVolume:+$("#originalVolume").value,
  ttsVolume:+$("#ttsVolume").value,
  subtitleEnabled:$("#subtitleEnabled").checked,
  subtitleStyle:$("#subtitleStyle").value,
  subtitlePreset:$("#subtitlePreset")?.value||"tiktok-classic",
  subtitleFont:$("#subtitleFont").value,
  subtitleSize:+$("#subtitleSize").value,
  subtitleColor:$("#subtitleColor").value,
  subtitleBackgroundColor:$("#subtitleBg").value,
  subtitleBackgroundOpacity:+$("#subtitleOpacity").value,
  subtitleX:+$("#subtitleX").value,
  subtitlePosition:+$("#subtitlePosition").value,
  ctaEnabled:Boolean($("#ctaEnabled")?.checked),
  ctaType:$("#ctaType")?.value||"cart",
  ctaText:$("#ctaText")?.value||"",
  ctaPosition:$("#ctaPosition")?.value||"bottom-left",
  sfxEnabled:$("#sfxEnabled")?.checked!==false,
  sfxVolume:+$("#sfxVolume")?.value||0.25
});

const segments=()=>[...document.querySelectorAll(".segment")].map((element,index)=>({
  id:element.dataset.id,
  start:+element.querySelector(".start").value,
  end:+element.querySelector(".end").value,
  subtitleText:element.querySelector(".sub").value,
  voiceOverText:element.querySelector(".voice").value,
  speaker:"speaker1",
  enabled:true,
  order:index
}));

function addSegment(segment={}){
  const element=document.createElement("div");
  element.className="segment";
  element.dataset.id=segment.id||crypto.randomUUID();
  element.innerHTML=`<input class="start" type="number" min="0" step=".1" value="${Number(segment.start||0)}" title="Bắt đầu"><input class="end" type="number" min=".1" step=".1" value="${Number(segment.end||3)}" title="Kết thúc"><textarea class="sub" placeholder="Phụ đề"></textarea><textarea class="voice" placeholder="Voice-over"></textarea><span class="budget"></span><button class="remove">Xóa</button>`;
  element.querySelector(".sub").value=segment.subtitleText||"";
  element.querySelector(".voice").value=segment.voiceOverText||"";
  element.querySelector(".remove").onclick=()=>{element.remove();syncWordBudgets();renderPreview()};
  $("#segments").append(element);
}

// Người dùng gõ lời đọc mà không biết đoạn có đủ thời gian để đọc hết hay không. Ngân sách chữ
// dùng đúng công thức phía render nên con số hiện ở đây khớp với thứ sẽ xảy ra khi xuất video.
function syncWordBudgets(){
  const ttsSpeed=+$("#ttsSpeed").value;
  for(const element of document.querySelectorAll(".segment")){
    const badge=element.querySelector(".budget");
    if(!badge)continue;
    const budget=LanaWordBudget.segmentWordBudget({
      start:+element.querySelector(".start").value,
      end:+element.querySelector(".end").value,
      text:element.querySelector(".voice").value,
      ttsSpeed
    });
    badge.textContent=LanaWordBudget.describeBudget(budget);
    badge.className=`budget ${["good","tight","over"].includes(budget.status)?budget.status:""}`.trim();
  }
}

function setControl(id,value,fallback){
  const element=$("#"+id);
  element.value=value??fallback;
  // Giá trị không nằm trong danh sách lựa chọn làm select rỗng đi. Rơi về mặc định để lần lưu
  // sau không gửi lên chuỗi rỗng.
  if(element.value==="")element.value=fallback;
}

const GOOGLE_DEFAULT_VOICE="vi-VN-Neural2-D";
const LUCYLAB_DEFAULT_VOICE="vcXEe1p3FxPfpswf3BhwbG";
const isLucylab=()=>$("#ttsProvider").value==="lucylab";
const usingGoogleVoice=()=>$("#ttsProvider").value==="google";
const isLucylabVoice=voice=>[...$("#lucylabVoice").options].some(option=>option.value===voice);
const pickedVoice=()=>{
  if(isLucylab())return $("#lucylabVoice").value;
  return usingGoogleVoice()?$("#googleVoice").value:$("#voice").value;
};

function ensureLucylabCreditUi(){
  let row=$("#lucylabCreditRow");
  if(row)return row;
  row=document.createElement("div");
  row.id="lucylabCreditRow";
  row.style.cssText="display:none;align-items:center;gap:8px;margin-top:8px";

  const pill=document.createElement("span");
  pill.style.cssText="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #bbf7d0;border-radius:999px;background:#f0fdf4;color:#166534;font-size:12px";
  const label=document.createElement("span");
  label.append("⚡ ViVibe: ");
  const value=document.createElement("strong");
  value.id="lucylabCredits";
  value.textContent="--";
  label.append(value," credit tạm tính");
  const button=document.createElement("button");
  button.type="button";
  button.id="refreshCreditsBtn";
  button.title="Làm mới credit tạm tính";
  button.setAttribute("aria-label","Làm mới credit Lucylab tạm tính");
  button.textContent="↻";
  button.style.cssText="border:0;background:transparent;color:inherit;cursor:pointer;padding:0 2px;font:inherit";
  pill.append(label,button);
  row.append(pill);
  $("#voiceNote").after(row);
  button.addEventListener("click",()=>fetchLucylabCredits(button));
  return row;
}

async function fetchLucylabCredits(button=$("#refreshCreditsBtn")){
  const creditsEl=$("#lucylabCredits");
  if(!creditsEl||!projectId)return;
  if(button){button.disabled=true;button.textContent="…"}
  try{
    const data=await api(`/api/video-analysis/projects/${encodeURIComponent(projectId)}/lucylab-credits`);
    creditsEl.textContent=typeof data.creditsRemaining==="number"
      ?`≈${data.creditsRemaining.toLocaleString("vi-VN")}`
      :"--";
  }catch(error){
    creditsEl.textContent="--";
    console.warn("Could not fetch Lucylab credit estimate:",error);
  }finally{
    if(button){button.disabled=false;button.textContent="↻"}
  }
}

function syncVoiceFields(){
  const provider=$("#ttsProvider").value;
  const lucy=provider==="lucylab";
  const google=provider==="google";
  const vertex=!lucy&&!google;

  $("#voiceField").hidden=!vertex;
  $("#voice").disabled=!vertex;
  $("#googleVoiceField").hidden=!google;
  $("#googleVoice").disabled=!google;
  if($("#lucylabVoiceField")){
    $("#lucylabVoiceField").hidden=!lucy;
    $("#lucylabVoice").disabled=!lucy;
  }
  const creditRow=ensureLucylabCreditUi();
  creditRow.style.display=lucy?"flex":"none";

  if(lucy){
    const opt=$("#lucylabVoice").selectedOptions[0];
    $("#voiceNote").textContent=`Lucylab AI đọc bằng ${opt?opt.textContent:$("#lucylabVoice").value}.`;
    fetchLucylabCredits();
  }else if(google){
    $("#voiceNote").textContent=`Google TTS đọc bằng ${$("#googleVoice").value}. Giọng Vertex (Kore, Puck…) không dùng được ở đây.`;
  }else{
    $("#voiceNote").textContent=`Vertex Gemini đọc bằng ${$("#voice").value}.`;
  }
}

// Brief do AI sinh có thể đã lưu một giọng Google ngoài danh sách. Giữ lại để lần lưu sau không
// âm thầm đổi giọng, nhưng loại các Lucylab ID từ bản PR cũ để chúng không lọt sang Google.
function fillGoogleVoice(saved){
  const select=$("#googleVoice");
  const googleVoice=isLucylabVoice(saved)?GOOGLE_DEFAULT_VOICE:saved;
  if(googleVoice&&![...select.options].some(option=>option.value===googleVoice)){
    select.append(new Option(googleVoice,googleVoice));
  }
  setControl("googleVoice",googleVoice,GOOGLE_DEFAULT_VOICE);
}

function syncRangeOutputs(){
  for(const [id,formatter] of Object.entries(RANGE_OUTPUTS)){
    const input=$("#"+id),output=$("#"+id+"Value");
    if(input&&output)output.value=formatter(input.value);
  }
}

function fill(){
  const saved=project.settings||{};
  $("#title").textContent=project.title;
  $("#summary").value=project.script.summary||"";
  $("#video").src=project.source.url||"";
  $("#sourceUrl").value=project.source.url||"";
  $("#sourceInfo").textContent=project.source.filename||"Chưa có video";
  for(const id of ["ttsEnabled","subtitleEnabled"])$("#"+id).checked=saved[id]!==false;
  setControl("ttsProvider",saved.ttsProvider,"vertex");
  setControl("ttsSpeed",saved.ttsSpeed,1);
  setControl("voice",saved.geminiSpeaker1Voice,"Kore");
  fillGoogleVoice(saved.ttsVoice);
  const legacyLucylabVoice=isLucylabVoice(saved.ttsVoice)?saved.ttsVoice:LUCYLAB_DEFAULT_VOICE;
  setControl("lucylabVoice",saved.lucylabVoice||legacyLucylabVoice,LUCYLAB_DEFAULT_VOICE);
  setControl("originalVolume",saved.originalAudioVolume,.25);
  setControl("ttsVolume",saved.ttsVolume,1);
  setControl("subtitleStyle",saved.subtitleStyle,"karaoke");
  setControl("subtitlePreset",saved.subtitlePreset,"tiktok-classic");
  setControl("subtitleFont",saved.subtitleFont,"TikTok Sans");
  setControl("subtitleSize",saved.subtitleSize,52);
  setControl("subtitleColor",saved.subtitleColor,"#FFFFFF");
  setControl("subtitleBg",saved.subtitleBackgroundColor,"#000000");
  setControl("subtitleOpacity",saved.subtitleBackgroundOpacity,.72);
  setControl("subtitleX",saved.subtitleX,50);
  setControl("subtitlePosition",saved.subtitlePosition,86);
  if ($("#ctaEnabled")) $("#ctaEnabled").checked = Boolean(saved.ctaEnabled);
  setControl("ctaType",saved.ctaType,"cart");
  if ($("#ctaText")) $("#ctaText").value = saved.ctaText || "";
  setControl("ctaPosition",saved.ctaPosition,"bottom-left");
  if ($("#sfxEnabled")) $("#sfxEnabled").checked = saved.sfxEnabled !== false;
  setControl("sfxVolume",saved.sfxVolume,0.25);
  $("#segments").innerHTML="";
  (project.script.segments||[]).forEach(addSegment);
  syncRangeOutputs();
  syncVoiceFields();
  syncWordBudgets();
  renderPreview();
}

// `note` do người gọi API đặt (thân của PUT /script), nên nhét thẳng vào innerHTML là mở đường
// cho script lạ chạy trong studio. Dựng bằng DOM để chuỗi luôn ở lại dạng văn bản.
function versionButton(version){
  const button=document.createElement("button");
  button.dataset.id=version.id;
  button.textContent=`v${version.version} · ${version.note} · ${new Date(version.created_at).toLocaleString("vi")}`;
  return button;
}

function invalidateRenderUi(){
  jobPollGeneration+=1;
  clearInterval(jobTimer);
  jobTimer=null;
  $("#download").hidden=true;
  $("#download").removeAttribute("href");
  $("#job").textContent="";
}

async function loadVersions(){
  const response=await api(`/api/video-analysis/projects/${projectId}/versions`);
  if(response.versions.length)$("#versions").replaceChildren(...response.versions.map(versionButton));
  else $("#versions").textContent="Chưa có phiên bản";
  $("#versions").querySelectorAll("button").forEach(button=>button.onclick=()=>
    api(`/api/video-analysis/projects/${projectId}/versions/${button.dataset.id}/restore`,{method:"POST"})
      .then(load)
      .catch(error=>alert(error.message)));
}

async function load(){
  project=await api(`/api/video-analysis/projects/${projectId}`);
  fill();
  await loadVersions();
  invalidateRenderUi();
  try{
    const data=await api(`/api/video-analysis/projects/${projectId}/latest-job`);
    if(data.job){
      if(data.job.status==="READY"){
        $("#job").textContent="READY · 100%";
        $("#download").hidden=false;
        $("#download").href=data.job.downloadUrl;
      }else if(data.job.status==="QUEUED"||data.job.status==="RENDERING"){
        await poll(data.job.id);
      }
    }
  }catch{}
}

async function save(approved,{refresh=true}={}){
  project=await api(`/api/video-analysis/projects/${projectId}/script`,{
    method:"PUT",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({approved,script:{summary:$("#summary").value,language:"vi-VN",segments:segments()},settings:settings()})
  });
  invalidateRenderUi();
  if(refresh){fill();await loadVersions()}
  return project;
}

const wordsOf=text=>String(text||"").trim().split(/\s+/u).filter(Boolean);
const activeWordIndex=(segment,time,wordCount)=>{
  if(!wordCount)return -1;
  const duration=Math.max(.001,Number(segment.end)-Number(segment.start));
  const progress=clamp((time-Number(segment.start))/duration,0,.999999);
  return Math.min(wordCount-1,Math.floor(progress*wordCount));
};
const hexAlpha=(hex,alpha)=>`${hex}${Math.round(clamp(Number(alpha),0,1)*255).toString(16).padStart(2,"0")}`;

function renderCaptionText(caption,segment,style,time){
  caption.replaceChildren();
  const text=segment?.subtitleText||"";
  const words=wordsOf(text),active=activeWordIndex(segment,time,words.length);
  if(style==="word"){
    const span=document.createElement("span");
    span.className="active-word";
    span.textContent=words[active]||"";
    caption.append(span);
    return;
  }
  if(style!=="karaoke"){
    caption.textContent=text;
    return;
  }
  let seen=-1;
  for(const token of String(text).split(/(\s+)/u)){
    if(token.trim())seen++;
    const span=document.createElement("span");
    if(token.trim()&&seen===active)span.className="active-word";
    span.textContent=token;
    caption.append(span);
  }
}
// Preview phải nghe giống bản render: Remotion bỏ hẳn tiếng gốc khi âm lượng bằng 0,
// nên thẻ <video> cũng phải mute thay vì giữ nguyên âm lượng của trình duyệt.
function applyPreviewVolume(currentSettings){
  const video=$("#video"),level=clamp(Number(currentSettings.originalAudioVolume)||0,0,1);
  video.muted=level<=0;
  video.volume=level;
}

function renderPreview(){
  if(!project)return;
  const currentSettings=settings(),video=$("#video"),time=video.currentTime;
  applyPreviewVolume(currentSettings);
  const segment=segments().find(item=>item.enabled!==false&&time>=item.start&&time<item.end);
  const caption=$("#caption"),stage=$("#stage");
  caption.hidden=!currentSettings.subtitleEnabled||!segment;
  if(caption.hidden)return;
  renderCaptionText(caption,segment,currentSettings.subtitleStyle,time);
  const scale=Math.max(.2,stage.clientWidth/1080);
  caption.classList.toggle("word-mode",currentSettings.subtitleStyle==="word");
  Object.assign(caption.style,{
    left:`${currentSettings.subtitleX}%`,
    top:`${currentSettings.subtitlePosition}%`,
    fontFamily:FONT_STACKS[currentSettings.subtitleFont]||currentSettings.subtitleFont,
    fontSize:`${Math.max(12,currentSettings.subtitleSize*scale)}px`,
    color:currentSettings.subtitleColor,
    background:hexAlpha(currentSettings.subtitleBackgroundColor,currentSettings.subtitleBackgroundOpacity),
    padding:`${Math.max(5,14*scale)}px ${Math.max(8,20*scale)}px`,
    borderRadius:`${Math.max(7,18*scale)}px`
  });
}

function updatePositionFromPointer(event){
  const rect=$("#stage").getBoundingClientRect();
  $("#subtitleX").value=clamp((event.clientX-rect.left)/rect.width*100,6,94);
  $("#subtitlePosition").value=clamp((event.clientY-rect.top)/rect.height*100,6,94);
  syncRangeOutputs();
  renderPreview();
}

const caption=$("#caption");
caption.addEventListener("pointerdown",event=>{
  if(caption.hidden)return;
  dragging=true;
  caption.classList.add("dragging");
  caption.setPointerCapture(event.pointerId);
  updatePositionFromPointer(event);
  event.preventDefault();
});
caption.addEventListener("pointermove",event=>{if(dragging)updatePositionFromPointer(event)});
const stopDragging=event=>{if(!dragging)return;dragging=false;caption.classList.remove("dragging");if(caption.hasPointerCapture(event.pointerId))caption.releasePointerCapture(event.pointerId)};
caption.addEventListener("pointerup",stopDragging);
caption.addEventListener("pointercancel",stopDragging);

$("#video").addEventListener("timeupdate",renderPreview);
$("#video").addEventListener("loadedmetadata",renderPreview);
window.addEventListener("resize",renderPreview);
const onStudioEdit=event=>{if(!event.target.closest("details"))return;syncRangeOutputs();syncWordBudgets();renderPreview();syncVoicePreview()};
document.addEventListener("input",onStudioEdit);
document.addEventListener("change",onStudioEdit);
document.fonts?.ready.then(renderPreview).catch(()=>{});
$("#subtitlePreset")?.addEventListener("change", (e) => {
  const p = e.target.value;
  if (p === "capcut-stroke") {
    $("#subtitleOpacity").value = 0;
    $("#subtitleColor").value = "#FFFFFF";
  } else if (p === "neon-glow") {
    $("#subtitleBg").value = "#111111";
    $("#subtitleOpacity").value = 0.65;
    $("#subtitleColor").value = "#FFFFFF";
  } else if (p === "tiktok-classic") {
    $("#subtitleBg").value = "#000000";
    $("#subtitleOpacity").value = 0.72;
    $("#subtitleColor").value = "#FFFFFF";
  }
  syncRangeOutputs();
  renderPreview();
});

$("#addSegment").onclick=()=>addSegment({start:$("#video").currentTime,end:$("#video").currentTime+3});
$("#save").onclick=()=>save(false).catch(error=>alert(error.message));
$("#approve").onclick=()=>save(true).catch(error=>alert(error.message));
// Mọi nút gọi mạng đều phải bắt lỗi: promise bị bỏ rơi chỉ hiện trong console, còn người dùng
// thấy một cái nút bấm xong không có gì xảy ra.
$("#attach").onclick=()=>
  api(`/api/video-analysis/projects/${projectId}/source-reference`,{
    method:"PUT",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({url:$("#sourceUrl").value,filename:"video-remote.mp4"})
  }).then(load).catch(error=>alert(error.message));

$("#upload").onchange=async event=>{
  const file=event.target.files[0];
  if(!file)return;
  try{
    const response=await fetch(`/api/video-analysis/projects/${projectId}/source-upload?filename=${encodeURIComponent(file.name)}`,{
      method:"POST",
      headers:{"content-type":file.type||"video/mp4"},
      body:file
    });
    // Không phải nhánh lỗi nào cũng trả JSON — tệp vượt giới hạn bị middleware chặn trước cả
    // route. Đọc kiểu phòng thủ để nút không chết lặng khi tải lên hỏng.
    if(!response.ok){
      const json=await response.json().catch(()=>({}));
      throw new Error(json.message||`Tải video lên thất bại (${response.status}).`);
    }
    await load();
  }catch(error){alert(error.message)}
  finally{event.target.value=""}
};
$("#render").onclick=async()=>{
  try{
    if(project.status!=="APPROVED")throw new Error("Hãy duyệt script trước khi render.");
    $("#render").disabled=true;
    $("#download").removeAttribute("href");
    $("#download").hidden=true;
    $("#job").textContent="Đang lưu thiết lập mới nhất…";
    await save(true,{refresh:false});
    const job=await api(`/api/video-analysis/projects/${projectId}/render-jobs`,{method:"POST"});
    await poll(job.id);
  }catch(error){
    alert(error.message);
    $("#job").textContent=error.message;
    $("#render").disabled=false;
  }
};

async function poll(id){
  clearInterval(jobTimer);
  jobTimer=null;
  const generation=++jobPollGeneration;
  $("#render").disabled=true;
  const run=async()=>{
    try{
      const job=await api(`/api/video-analysis/jobs/${id}`);
      if(generation!==jobPollGeneration)return false;
      $("#job").textContent=`${job.status} · ${job.progress}%${job.error?" · "+job.error:""}`;
      if(job.status==="READY"){
        $("#download").hidden=false;
        $("#download").href=job.downloadUrl;
        $("#render").disabled=false;
        if(isLucylab())fetchLucylabCredits();
        return false;
      }
      if(job.status==="FAILED"){
        $("#render").disabled=false;
        return false;
      }
      return true;
    }catch(error){
      if(generation!==jobPollGeneration)return false;
      $("#render").disabled=false;
      $("#job").textContent=`Mất liên lạc với job: ${error.message}`;
      return false;
    }
  };
  if(await run()){
    const timer=setInterval(async()=>{
      if(!await run()){
        clearInterval(timer);
        if(jobTimer===timer)jobTimer=null;
      }
    },2000);
    jobTimer=timer;
  }
}

// Lưu trước khi tải để tệp khớp đúng thứ đang thấy trên màn hình. Phải giữ nguyên trạng thái
// duyệt: `save(false)` hạ một dự án đã duyệt xuống DRAFT, và người dùng chỉ phát hiện ra ở lần
// bấm Render kế tiếp khi nó đòi duyệt lại.
const keepApproval=()=>project.status==="APPROVED";

async function downloadSubtitles(format){
  await save(keepApproval(),{refresh:false});
  location.href=`/api/video-analysis/projects/${projectId}/subtitles?format=${format}`;
}
$("#downloadSrt").onclick=()=>downloadSubtitles("srt").catch(error=>alert(error.message));
$("#downloadVtt").onclick=()=>downloadSubtitles("vtt").catch(error=>alert(error.message));

let sampleAudio,sampleGeneration=0;
function stopSampleAudio(){
  sampleGeneration++;
  sampleAudio?.pause();
}

$("#voiceSample").onclick=async()=>{
  const button=$("#voiceSample"),generation=++sampleGeneration;
  button.disabled=true;
  sampleAudio?.pause();
  try{
    const response=await api(`/api/video-analysis/projects/${projectId}/voice-sample`,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({ttsProvider:$("#ttsProvider").value,voice:pickedVoice()})
    });
    if(generation!==sampleGeneration)return;
    sampleAudio=new Audio(response.url);
    sampleAudio.volume=clamp(+$("#ttsVolume").value,0,1)||1;
    // Server mới là nơi quyết định giọng nào được đọc, nên nói lại đúng tên nó trả về.
    $("#voiceNote").textContent=`Đang đọc thử bằng ${response.voice}.`;
    await sampleAudio.play();
    if(isLucylab())fetchLucylabCredits();
  }catch(error){
    if(generation!==sampleGeneration)return;
    syncVoiceFields();
    alert(error.message);
  }finally{button.disabled=false}
};

// Nghe thử giọng đọc ngay trên preview: dùng đúng các clip mà bản render sẽ dùng, đặt đúng mốc
// thời gian của từng đoạn, trộn với tiếng gốc theo hai thanh âm lượng.
let voiceClips=[];
const voicePreviewOn=()=>voiceClips.length>0;

function stopVoicePreview(){
  for(const {audio} of voiceClips){audio.pause();audio.removeAttribute("src");audio.load()}
  voiceClips=[];
  $("#voicePreview").textContent="▶ Nghe thử giọng đọc trên video";
  $("#voicePreviewInfo").textContent="";
}

function syncVoicePreview(){
  if(!voicePreviewOn())return;
  const video=$("#video"),time=video.currentTime,volume=clamp(+$("#ttsVolume").value,0,1);
  for(const {track,audio} of voiceClips){
    const offset=time-track.start;
    audio.volume=volume;
    if(offset<0||offset>=track.duration||video.paused||volume<=0){
      if(!audio.paused)audio.pause();
      continue;
    }
    const target=offset*(Number(track.playbackRate)||1);
    if(Math.abs(audio.currentTime-target)>.25)audio.currentTime=target;
    if(audio.paused)audio.play().catch(()=>{});
  }
}

$("#voicePreview").onclick=async()=>{
  stopSampleAudio();
  if(voicePreviewOn()){stopVoicePreview();return}
  const button=$("#voicePreview");
  button.disabled=true;
  $("#voicePreviewInfo").textContent="Đang tạo giọng đọc…";
  try{
    await save(keepApproval(),{refresh:false});
    const response=await api(`/api/video-analysis/projects/${projectId}/voice-preview`,{method:"POST"});
    voiceClips=response.voiceTracks.map(track=>{
      const audio=new Audio(track.url);
      audio.preload="auto";
      audio.playbackRate=Number(track.playbackRate)||1;
      return{track,audio};
    });
    $("#voicePreview").textContent="■ Tắt nghe thử";
    $("#voicePreviewInfo").textContent=`${voiceClips.length} đoạn đã sẵn sàng`;
    syncVoicePreview();
    if(isLucylab())fetchLucylabCredits();
  }catch(error){stopVoicePreview();alert(error.message)}
  finally{button.disabled=false}
};

$("#video").addEventListener("play",stopSampleAudio);
for(const event of ["timeupdate","play","pause","seeking","seeked","ratechange"]){
  $("#video").addEventListener(event,syncVoicePreview);
}
// Sửa lời đọc hay mốc thời gian thì các clip đang giữ không còn đúng nữa. Riêng phụ đề thì
// không đụng tới giọng đọc nên không cần dựng lại.
$("#segments").addEventListener("input",event=>{
  if(voicePreviewOn()&&event.target.matches(".voice,.start,.end"))stopVoicePreview();
});
for(const id of ["#voice","#googleVoice","#lucylabVoice","#ttsProvider","#ttsSpeed"]){
  $(id).addEventListener("change",()=>{syncVoiceFields();if(voicePreviewOn())stopVoicePreview()});
}

$("#newBtn").onclick=()=>{location.href="/video-studio"};
ensure().catch(error=>alert(error.message));
