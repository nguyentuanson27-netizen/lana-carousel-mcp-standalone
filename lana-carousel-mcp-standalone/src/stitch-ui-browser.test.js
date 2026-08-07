import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source=await fs.readFile(new URL("../public/stitch-ui.js",import.meta.url),"utf8");

class FakeClassList{
 constructor(names=[]){this.values=new Set(names)}
 add(...names){names.forEach(name=>this.values.add(name))}
 remove(...names){names.forEach(name=>this.values.delete(name))}
 contains(name){return this.values.has(name)}
 toggle(name,force){
  if(force===true){this.values.add(name);return true}
  if(force===false){this.values.delete(name);return false}
  if(this.values.has(name)){this.values.delete(name);return false}
  this.values.add(name);return true;
 }
}

class FakeElement{
 constructor({dataset={},classes=[],disabled=false}={}){
  this.dataset={...dataset};
  this.classList=new FakeClassList(classes);
  this.disabled=disabled;
  this.hidden=false;
  this.textContent="";
  this.innerHTML="";
  this.title="";
  this.attributes=new Map();
  this.listeners=new Map();
  this.clickCount=0;
 }
 addEventListener(type,listener){
  const listeners=this.listeners.get(type)||[];
  listeners.push(listener);
  this.listeners.set(type,listeners);
 }
 dispatch(type,extra={}){
  const event={target:this,...extra};
  for(const listener of this.listeners.get(type)||[]) listener(event);
 }
 click(){this.clickCount+=1;this.dispatch("click")}
 setAttribute(name,value){this.attributes.set(name,String(value))}
 getAttribute(name){return this.attributes.get(name)}
 removeAttribute(name){this.attributes.delete(name)}
 querySelector(){return null}
 querySelectorAll(){return[]}
}

function createHarness({fetchImpl=async()=>({ok:true})}={}){
 const slideCollapse=new FakeElement();
 const slideSearch=new FakeElement();
 const slideFilters=new FakeElement();
 const slideRail=new FakeElement();
 const studioSidebar=new FakeElement();
 const mobileBackdrop=new FakeElement();
 const mobileSidebarToggle=new FakeElement();
 const sidebarClose=new FakeElement();
 const workflow=new FakeElement();
 const contentStep=new FakeElement({dataset:{view:"content"},classes:["step","active"]});
 const imagesStep=new FakeElement({dataset:{view:"images"},classes:["step"]});
 const nextAction=new FakeElement();
 const approveContent=new FakeElement();
 const saveVideo=new FakeElement();
 const saveState=new FakeElement();
 const app=new FakeElement({classes:["hidden"]});
 const body=new FakeElement();
 const elements=new Map([
  ["#slideNavCollapse",slideCollapse],
  ["#slideSearch",slideSearch],
  ["#slideFilters",slideFilters],
  ["#slideRail",slideRail],
  ["#studioSidebar",studioSidebar],
  ["#mobileBackdrop",mobileBackdrop],
  ["#mobileSidebarToggle",mobileSidebarToggle],
  ["#sidebarClose",sidebarClose],
  ["#workflow",workflow],
  ["#workflow .step.active",contentStep],
  ["#workflow .step[data-view=\"content\"]",contentStep],
  ["#nextWorkflowAction",nextAction],
  ["#approveContent",approveContent],
  ["#saveVideo",saveVideo],
  ["#saveState",saveState],
  ["#app",app]
 ]);
 const document={
  body,
  querySelector:selector=>elements.get(selector)||null,
  querySelectorAll:selector=>selector==="#workflow .step"?[contentStep,imagesStep]:[],
  createElement:()=>new FakeElement()
 };
 const loadListeners=[];
 const window={
  fetch:fetchImpl,
  addEventListener:(type,listener)=>{if(type==="load")loadListeners.push(listener)}
 };
 class FakeMutationObserver{
  constructor(callback){this.callback=callback}
  observe(){this.observing=true}
  disconnect(){this.observing=false}
 }
 const context={
  document,
  window,
  MutationObserver:FakeMutationObserver,
  requestAnimationFrame:callback=>callback(),
  setTimeout:callback=>callback(),
  innerWidth:1200,
  console
 };
 vm.runInNewContext(source,context,{filename:"stitch-ui.js"});
 return{
  context,slideCollapse,slideSearch,slideFilters,slideRail,studioSidebar,
  mobileBackdrop,mobileSidebarToggle,sidebarClose,contentStep,imagesStep,
  nextAction,approveContent,saveVideo,saveState,loadListeners
 };
}

test("slide navigation collapse toggles controls and accessible state",()=>{
 const ui=createHarness();
 assert.equal(ui.slideCollapse.textContent,"−");
 assert.equal(ui.slideCollapse.getAttribute("aria-expanded"),"true");
 ui.slideCollapse.click();
 assert.equal(ui.slideSearch.hidden,true);
 assert.equal(ui.slideFilters.hidden,true);
 assert.equal(ui.slideRail.hidden,true);
 assert.equal(ui.slideCollapse.textContent,"+");
 assert.equal(ui.slideCollapse.getAttribute("aria-expanded"),"false");
 ui.slideCollapse.click();
 assert.equal(ui.slideSearch.hidden,false);
 assert.equal(ui.slideCollapse.getAttribute("aria-expanded"),"true");
});

test("primary workflow CTA delegates to the real completion controls",()=>{
 const ui=createHarness();
 ui.nextAction.dataset.mode="approve-content";
 ui.nextAction.click();
 assert.equal(ui.approveContent.clickCount,1);
 ui.nextAction.dataset.mode="save-video";
 ui.nextAction.click();
 assert.equal(ui.saveVideo.clickCount,1);
});

test("primary workflow CTA navigates only to an enabled next step",()=>{
 const ui=createHarness();
 ui.nextAction.dataset.mode="navigate";
 ui.nextAction.click();
 assert.equal(ui.imagesStep.clickCount,1);
 ui.imagesStep.disabled=true;
 ui.nextAction.click();
 assert.equal(ui.imagesStep.clickCount,1);
 ui.nextAction.disabled=true;
 ui.nextAction.dataset.mode="approve-content";
 ui.nextAction.click();
 assert.equal(ui.approveContent.clickCount,0);
});

test("mobile sidebar controls update the drawer and backdrop",()=>{
 const ui=createHarness();
 ui.mobileBackdrop.hidden=true;
 ui.mobileSidebarToggle.click();
 assert.equal(ui.studioSidebar.classList.contains("open"),true);
 assert.equal(ui.mobileBackdrop.hidden,false);
 ui.sidebarClose.click();
 assert.equal(ui.studioSidebar.classList.contains("open"),false);
 assert.equal(ui.mobileBackdrop.hidden,true);
});

test("mutating API requests report success from the real response",async()=>{
 const ui=createHarness({fetchImpl:async()=>({ok:true})});
 await ui.context.window.fetch("/api/projects/example",{method:"PATCH"});
 assert.match(ui.saveState.innerHTML,/Đã cập nhật/u);
 assert.equal(ui.saveState.classList.contains("error"),false);
});

test("mutating API requests report HTTP and network failures",async()=>{
 const httpFailure=createHarness({fetchImpl:async()=>({ok:false})});
 await httpFailure.context.window.fetch("/api/projects/example",{method:"POST"});
 assert.match(httpFailure.saveState.innerHTML,/Cập nhật thất bại/u);
 assert.equal(httpFailure.saveState.classList.contains("error"),true);

 const networkFailure=createHarness({fetchImpl:async()=>{throw new Error("offline")}});
 await assert.rejects(
  networkFailure.context.window.fetch("/api/projects/example",{method:"DELETE"}),
  /offline/u
 );
 assert.match(networkFailure.saveState.innerHTML,/Cập nhật thất bại/u);
 assert.equal(networkFailure.saveState.classList.contains("error"),true);
});

test("read-only requests do not alter the save indicator",async()=>{
 const ui=createHarness({fetchImpl:async()=>({ok:true})});
 ui.saveState.innerHTML="Không có thay đổi";
 await ui.context.window.fetch("/api/projects/example",{method:"GET"});
 assert.equal(ui.saveState.innerHTML,"Không có thay đổi");
});
