const ACTIVE_STATUSES=new Set(["QUEUED","RENDERING"]);

export function createVideoAnalysisJobRegistry(){
 const jobs=new Map();
 const queue=[];
 return{
  jobs,
  queue,
  add(job){jobs.set(job.id,job);return job;},
  enqueue(job){queue.push(job);return job;},
  shift(){return queue.shift();},
  hasActiveProject(projectId){
   return [...jobs.values()].some(job=>job.projectId===projectId&&ACTIVE_STATUSES.has(job.status));
  },
  forgetProject(projectId){
   let removedQueued=0;
   for(let index=queue.length-1;index>=0;index-=1){
    if(queue[index].projectId===projectId){queue.splice(index,1);removedQueued+=1;}
   }
   let removedJobs=0;
   for(const [jobId,job] of jobs){
    if(job.projectId===projectId){jobs.delete(jobId);removedJobs+=1;}
   }
   return{removedQueued,removedJobs};
  }
 };
}

export const videoAnalysisJobRegistry=createVideoAnalysisJobRegistry();
