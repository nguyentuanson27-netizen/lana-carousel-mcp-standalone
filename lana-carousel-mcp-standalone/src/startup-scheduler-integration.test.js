import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("production import graph registers render, video and audio cleanup schedulers", async () => {
  const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),"lana-startup-schedulers-"));
  const moduleUrl=new URL("./mcp-tools.js",import.meta.url).href;
  const script=`
    const delays=[];
    const originalSetInterval=globalThis.setInterval;
    globalThis.setInterval=(handler,delay,...args)=>{
      delays.push(Number(delay));
      return {unref(){return this},ref(){return this},close(){}};
    };
    try {
      await import(${JSON.stringify(moduleUrl)});
      await import(new URL("./video-jobs.js", ${JSON.stringify(moduleUrl)}).href);
      console.log("__LANA_INTERVALS__"+JSON.stringify(delays));
    } finally {
      globalThis.setInterval=originalSetInterval;
    }
  `;
  const result=spawnSync(process.execPath,["--input-type=module","-e",script],{
    encoding:"utf8",
    timeout:30000,
    env:{
      ...process.env,
      NODE_ENV:"production",
      API_KEY:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      DATABASE_PATH:path.join(tempRoot,"lana.sqlite"),
      ASSET_DIRECTORY:path.join(tempRoot,"assets"),
      PUBLIC_BASE_URL:"https://scheduler-integration.test"
    }
  });
  try{
    assert.equal(result.status,0,result.stderr||result.stdout);
    const marker=result.stdout.split(/\r?\n/u).find(line=>line.startsWith("__LANA_INTERVALS__"));
    assert.ok(marker,`Không tìm thấy scheduler marker trong output: ${result.stdout}`);
    const delays=JSON.parse(marker.slice("__LANA_INTERVALS__".length));
    assert.ok(delays.includes(15*60*1000),"Render ZIP cleanup timer 15 phút chưa được đăng ký.");
    assert.ok(
      delays.filter(delay=>delay===60*60*1000).length>=3,
      `Thiếu timer cleanup 1 giờ cho video/audio: ${JSON.stringify(delays)}`
    );
  }finally{
    await fs.rm(tempRoot,{recursive:true,force:true});
  }
});

test("project audio bootstrap does not monkey-patch global scheduling APIs", async () => {
  const source=await fs.readFile(new URL("./project-audio.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/globalThis\.setInterval\s*=/u);
  assert.doesNotMatch(source,/fsSync\.watch\s*=/u);
  assert.match(source,/startProjectAudioMaintenance/u);
  assert.match(source,/migrateLegacyProjectAudio/u);
});
