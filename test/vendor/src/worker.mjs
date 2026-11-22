import {ENVIRONMENT,STATE_CONTEXT,requireStateContext} from './network.mjs';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {uuid} from './reviewer.mjs';
export function validateWork(a,jobId){
 if(a?.jobId!==jobId||!uuid(a.leaseId)||a.timingVersion!==2||!a.brief||typeof a.brief.brief!=='string')throw Error('Invalid worker assignment');
 for(const k of ['expiresAt','workDeadline','deadline'])if(!Number.isFinite(Date.parse(a[k])))throw Error('Invalid worker deadline');
 if(Date.parse(a.expiresAt)>Date.parse(a.workDeadline)||Date.parse(a.workDeadline)>Date.parse(a.deadline))throw Error('Invalid worker deadline ordering');
 return a;
}
export function workerReport(input){if(!input||Object.keys(input).join(',')!=='markdown'||typeof input.markdown!=='string'||!input.markdown.trim()||input.markdown.includes('\0')||Buffer.byteLength(input.markdown)>65536)throw Error('Invalid report; expected {markdown} up to 65536 UTF-8 bytes');return input.markdown;}
export async function runWorker(client,store,identity,jobId,{revision=false,signal,interval=1000,pulseMs=30000,log=()=>{}}={}){
 if(!uuid(jobId)||!uuid(identity.instanceId)||typeof identity.minRewardAtomic!=='string'||!/^[1-9][0-9]{0,12}$/.test(identity.minRewardAtomic))throw Error('Worker job UUID, instance UUID and reward floor required');
 const unlock=await store.lock();let active,timer,busy=false,lost=false;
 const instance=()=>client.request('/agents/instances/heartbeat',{instanceId:identity.instanceId,slots:1,minRewardAtomic:identity.minRewardAtomic});
 try{
  active=await store.read('worker-active.json');
  if(active)requireStateContext(active);
  if(active&&active.phase!=='submitted'&&active.jobId!==jobId)throw Error('Another worker job requires reconciliation');
  if(!active||active.phase==='submitted'&&(revision||active.jobId!==jobId)){
   const listing=await client.request('/public/jobs/'+jobId,undefined,{auth:false});
   if(listing.publicId!==jobId||listing.currency!=='USDC'||listing.timingVersion!==2||listing.jobType!=='research_report'||typeof listing.rewardAtomic!=='string'||!/^\d{1,13}$/.test(listing.rewardAtomic)||BigInt(listing.rewardAtomic)<BigInt(identity.minRewardAtomic)||!revision&&listing.status!=='open')throw Error('Job type, status or worker reward floor mismatch');
   active={...(ENVIRONMENT==='mainnet'?{deployment:STATE_CONTEXT}:{}),jobId,phase:'claim_pending',revision};await store.write('worker-active.json',active);
   await instance();
   // Freeze claim intent first. A lost reply is recovered read-only, never with
   // another claim that might allocate a fresh lease.
   if(revision){active.assignment=await client.request('/jobs/'+jobId+'/assignment');if(active.assignment.status!=='revision')throw Error('No revision requested by the server');}
   else active.assignment=await client.request('/jobs/'+jobId+'/claim',{instanceId:identity.instanceId});
   validateWork(active.assignment,jobId);active.phase='claimed';await store.write('worker-active.json',active);
  }else if(!active.assignment){active.assignment=validateWork(await client.request('/jobs/'+jobId+'/assignment'),jobId);active.phase='claimed';await store.write('worker-active.json',active);}
  if(active.phase==='submitted')return active.result;
  const base='/jobs/'+jobId;
  if(!active.submission){
   const handoff='work-'+createHash('sha256').update(active.assignment.leaseId).digest('hex').slice(0,32),work=new store.constructor(store.root+'/'+handoff);await work.init();
   await work.write('assignment.json',{jobId,brief:active.assignment.brief,expiresAt:active.assignment.expiresAt,workDeadline:active.assignment.workDeadline,deadline:active.assignment.deadline,...(active.assignment.review?{review:active.assignment.review}:{})});log('worker_assignment_ready:'+handoff);
   const pulse=async()=>{if(busy||signal?.aborted)return;busy=true;try{const p=await client.request(base+'/heartbeat',{leaseId:active.assignment.leaseId});if(!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)>Date.parse(active.assignment.workDeadline))throw Error('Invalid worker heartbeat');active.assignment.expiresAt=p.expiresAt;await instance();}catch{lost=true;}finally{busy=false;}};
   await pulse();timer=setInterval(()=>{void pulse();},pulseMs);
   try{while(!signal?.aborted){
    if(lost)throw Error('Worker heartbeat failed; state retained');
    if(Date.now()>=Math.min(Date.parse(active.assignment.expiresAt),Date.parse(active.assignment.workDeadline)))throw Error('Worker lease expired; state retained');
    const report=await work.read('report.json');if(report){active.submission={leaseId:active.assignment.leaseId,markdown:workerReport(report)};if(lost)throw Error('Worker heartbeat failed');await store.write('worker-active.json',active);break;}
    await sleep(interval,undefined,{signal}).catch(()=>{});
   }}finally{clearInterval(timer);timer=undefined;while(busy)await sleep(10);}
   if(signal?.aborted)return;
   if(lost)throw Error('Worker heartbeat failed before submission; exact body retained');
  }
  // Server supports exact submission replay even after status changes.
  active.result=await client.request(base+'/submit',active.submission);active.phase='submitted';
  await store.write('worker-'+jobId+'-'+active.assignment.leaseId+'.json',active);await store.write('worker-active.json',active);log('worker_submission_acknowledged');return active.result;
 }finally{if(timer)clearInterval(timer);while(busy)await sleep(10);await unlock();}
}
