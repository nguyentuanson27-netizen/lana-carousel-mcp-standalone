import assert from "node:assert/strict";
import test from "node:test";
import {createVideoAnalysisJobRegistry} from "./video-analysis-job-registry.js";

test("detects active jobs and removes all project jobs from queue and memory",()=>{
 const registry=createVideoAnalysisJobRegistry();
 const queued={id:"queued",projectId:"project-1",status:"QUEUED"};
 const rendering={id:"rendering",projectId:"project-1",status:"RENDERING"};
 const ready={id:"ready",projectId:"project-1",status:"READY"};
 const other={id:"other",projectId:"project-2",status:"QUEUED"};
 for(const job of [queued,rendering,ready,other])registry.add(job);
 registry.enqueue(queued);
 registry.enqueue(other);
 assert.equal(registry.hasActiveProject("project-1"),true);
 const removed=registry.forgetProject("project-1");
 assert.deepEqual(removed,{removedQueued:1,removedJobs:3});
 assert.equal(registry.hasActiveProject("project-1"),false);
 assert.deepEqual(registry.queue,[other]);
 assert.deepEqual([...registry.jobs.keys()],["other"]);
});

test("completed jobs are not considered active",()=>{
 const registry=createVideoAnalysisJobRegistry();
 registry.add({id:"ready",projectId:"project-1",status:"READY"});
 registry.add({id:"failed",projectId:"project-1",status:"FAILED"});
 assert.equal(registry.hasActiveProject("project-1"),false);
});
