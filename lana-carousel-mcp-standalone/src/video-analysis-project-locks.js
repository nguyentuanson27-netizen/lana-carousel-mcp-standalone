const mutationTails=new Map();
const pendingMutations=new Map();

export function isVideoSourceMutationPending(projectId){
 return (pendingMutations.get(String(projectId))||0)>0;
}

export async function withVideoSourceMutationLock(projectId,work){
 const key=String(projectId);
 pendingMutations.set(key,(pendingMutations.get(key)||0)+1);
 const previous=mutationTails.get(key)||Promise.resolve();
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const tail=previous.catch(()=>{}).then(()=>gate);
 mutationTails.set(key,tail);
 await previous.catch(()=>{});
 try{
  return await work();
 }finally{
  release();
  const remaining=(pendingMutations.get(key)||1)-1;
  if(remaining>0)pendingMutations.set(key,remaining);
  else pendingMutations.delete(key);
  if(mutationTails.get(key)===tail)mutationTails.delete(key);
 }
}
