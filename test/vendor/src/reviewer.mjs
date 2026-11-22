import {ENVIRONMENT,STATE_CONTEXT,requireStateContext} from './network.mjs';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ApiError} from './api.mjs';
import {canonical} from './canonical.mjs';
import {criteriaFor,proofContext,validateRetainedProof} from './review-proof.mjs';
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateDispatch(d){if(!uuid(d?.jobId)||!uuid(d?.dispatchToken)||d.timingVersion!==2||!Number.isInteger(d.attempt)||d.attempt<1||d.attempt>9)throw Error('Unsupported dispatch: v2 required');return d;}
export function validateAssignment(a,d){if(a?.jobId!==d.jobId||a.timingVersion!==2||!digest(a.briefHash)||!digest(a.submissionHash)||typeof a.markdown!=='string'||!Array.isArray(a.requiredCriteria)||!a.requiredCriteria.length||a.requiredCriteria.some(x=>typeof x!=='string')||new Set(a.requiredCriteria).size!==a.requiredCriteria.length||createHash('sha256').update(a.markdown).digest('hex')!==a.submissionHash||createHash('sha256').update(canonical(a.brief)).digest('hex')!==a.briefHash||canonical(criteriaFor(a.brief))!==canonical(a.requiredCriteria))throw Error('Invalid assignment/report digest');return a;}
export function deadlines(t){const out={};for(const key of ['leaseUntil','processingDeadline','hardDeadline']){out[key]=Date.parse(t?.[key]);if(!Number.isFinite(out[key]))throw Error('Invalid deadline contract');}if(out.leaseUntil>out.processingDeadline||out.processingDeadline>out.hardDeadline)throw Error('Invalid deadline ordering');return out;}
export function receiptFor(decision,a,d,retained){
 validateDispatch(d);validateAssignment(a,d);
 if(!decision||Object.keys(decision).sort().join(',')!=='checks,reason,verdict'||!['ACCEPT','REVISE','REJECT','INCONCLUSIVE'].includes(decision.verdict)||typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>2000||!Array.isArray(decision.checks)||decision.checks.length!==a.requiredCriteria.length)throw Error('Invalid decision shape');
 const seen=new Set();for(const c of decision.checks){if(!c||Object.keys(c).sort().join(',')!=='criterion,evidenceIds,quote,reason,status'||!a.requiredCriteria.includes(c.criterion)||seen.has(c.criterion)||!['PASS','FAIL','UNVERIFIED'].includes(c.status)||typeof c.reason!=='string'||!c.reason.trim()||c.reason.length>1000||!Array.isArray(c.evidenceIds)||c.evidenceIds.some(x=>!uuid(x)))throw Error('Invalid criterion decision');seen.add(c.criterion);if(c.status==='UNVERIFIED'?(c.evidenceIds.length||c.quote!==null):(!c.evidenceIds.length||typeof c.quote!=='string'||!c.quote.trim()))throw Error('Unsupported check evidence');}
 const unknown=decision.checks.some(c=>c.status==='UNVERIFIED'),fail=decision.checks.some(c=>c.status==='FAIL');if(decision.verdict==='ACCEPT'&&(unknown||fail)||['REJECT','REVISE'].includes(decision.verdict)&&(!fail||unknown)||decision.verdict==='INCONCLUSIVE'&&!unknown)throw Error('Inconsistent verdict');
 validateRetainedProof(decision,a,d,retained);
 return {...decision,attempt:d.attempt,dispatchToken:d.dispatchToken,briefHash:a.briefHash,submissionHash:a.submissionHash};
}
export async function availability(client,identity){await client.request('/agents/instances/heartbeat',{instanceId:identity.instanceId,slots:1,minRewardAtomic:identity.minRewardAtomic});await client.request('/reviews/heartbeat',{});}
// No model or shell command is invoked. The independently operated agent reads
// assignment/evidence files and writes source requests and its own decision.
export async function runReviewer(client,store,identity,{signal,once=false,interval=1000,pulseMs=30000,log=()=>{}}={}){
 const release=await store.lock();let busy=false,lost=false,active=await store.read('active.json'),timer;
 const pulse=async()=>{if(busy||signal?.aborted)return;busy=true;try{if(active?.assignment&&!active.receipt){const t=await client.request('/jobs/'+active.dispatch.jobId+'/review/heartbeat',{dispatchToken:active.dispatch.dispatchToken});deadlines(t);active.assignment={...active.assignment,...t};}await availability(client,identity);}catch{lost=true;}finally{busy=false;}};
 try{
  if(active)requireStateContext(active);
  if(active?.phase==='completed')active=null;
  if(!active){await availability(client,identity);const {dispatch}=await client.request('/reviews/next',{instanceId:identity.instanceId});if(!dispatch){log('queue_empty');if(once)return;}
   else{validateDispatch(dispatch);active={...(ENVIRONMENT==='mainnet'?{deployment:STATE_CONTEXT}:{}),dispatch,phase:'offered'};await store.write('active.json',active);}}
  while(!signal?.aborted){
   if(!active){await sleep(5000,undefined,{signal}).catch(()=>{});if(signal?.aborted)break;await availability(client,identity);const {dispatch}=await client.request('/reviews/next',{instanceId:identity.instanceId});if(!dispatch)continue;active={...(ENVIRONMENT==='mainnet'?{deployment:STATE_CONTEXT}:{}),dispatch:validateDispatch(dispatch),phase:'offered'};await store.write('active.json',active);}
   const base='/jobs/'+active.dispatch.jobId+'/review';
   // Always replay the same persisted receipt first, even after a lost reply.
   if(active.receipt){const r=await client.request(base,active.receipt);active.phase='completed';active.result=r;await store.write('receipt-'+active.dispatch.jobId+'-'+active.dispatch.attempt+'.json',active);await store.write('active.json',active);log('receipt_acknowledged');if(once)return;active=null;continue;}
   if(!active.assignment){const a=await client.request(base+'/claim',{dispatchToken:active.dispatch.dispatchToken});active.assignment=validateAssignment(a,active.dispatch);deadlines(a);active.phase='claimed';await store.write('active.json',active);}
   if(active.sources && canonical(active.evidenceContext??null)!==canonical(proofContext(active.assignment,active.dispatch))){
    active.previousEvidence={sources:active.evidence??[],citationCheck:active.citationCheck??null};
    active.evidence=[];active.citationCheck=null;active.evidenceDone=false;
    active.evidenceContext=proofContext(active.assignment,active.dispatch);await store.write('active.json',active);
   }
   const handoff=createHash('sha256').update(active.dispatch.dispatchToken).digest('hex').slice(0,32);
   // Per-dispatch directories prevent a late response for an old assignment
   // from being submitted for the next one. Never expose tokens to the handler.
   const work=new store.constructor(store.root+'/'+handoff);await work.init();
   await work.write('assignment.json',{jobId:active.dispatch.jobId,brief:active.assignment.brief,markdown:active.assignment.markdown,requiredCriteria:active.assignment.requiredCriteria,briefHash:active.assignment.briefHash,submissionHash:active.assignment.submissionHash,leaseUntil:active.assignment.leaseUntil,processingDeadline:active.assignment.processingDeadline,hardDeadline:active.assignment.hardDeadline});
   log('assignment_ready:'+handoff);lost=false;await pulse();timer=setInterval(()=>{void pulse();},pulseMs);
   try{while(!signal?.aborted){
    if(lost)throw Error('Heartbeat failed; active state retained for reconciliation');
    const t=deadlines(active.assignment);if(Date.now()>=Math.min(t.leaseUntil,t.processingDeadline,t.hardDeadline))throw Error('Review deadline expired; active state retained');
    const sources=await work.read('sources.json');
    if(sources&&!active.sources){if(!Array.isArray(sources.urls)||sources.urls.length>8||sources.urls.some(u=>typeof u!=='string'||u.length>4096)||Object.keys(sources).some(k=>!['urls','citationCheck'].includes(k))||sources.citationCheck!==undefined&&typeof sources.citationCheck!=='boolean')throw Error('Invalid source request');active.sources=sources;active.evidence=[];active.evidenceContext=proofContext(active.assignment,active.dispatch);await store.write('active.json',active);}
    if(active.sources&&!active.evidenceDone){
     for(const url of active.sources.urls.slice(active.evidence.length)){let result;try{result={url,status:200,body:await client.request(base+'/evidence',{dispatchToken:active.dispatch.dispatchToken,url})};}catch(e){if(!(e instanceof ApiError)||![400,422].includes(e.status))throw e;result={url,status:e.status,error:e.code,...(e.status===422&&uuid(e.details?.attemptId)?{attemptId:e.details.attemptId}:{})};}result.context=active.evidenceContext;active.evidence.push(result);await store.write('active.json',active);}
     if(active.sources.citationCheck){let result;try{result={status:200,body:await client.request(base+'/citation-check',{dispatchToken:active.dispatch.dispatchToken})};}catch(e){if(!(e instanceof ApiError)||e.status!==409||e.code!=='supported_source_present')throw e;result={status:e.status,error:e.code};}result.context=active.evidenceContext;active.citationCheck=result;}
     active.evidenceDone=true;await store.write('active.json',active);
    }
    await work.write('evidence.json',{sources:active.evidence??[],citationCheck:active.citationCheck??null});
    const decision=await work.read('decision.json');
    if(decision){if(!active.evidenceDone)throw Error('Request and inspect evidence before submitting a decision');active.receipt=receiptFor(decision,active.assignment,active.dispatch,{context:active.evidenceContext,sources:active.evidence,citationCheck:active.citationCheck});if(lost||signal?.aborted)throw Error('Review interrupted');await store.write('active.json',active);break;}
    await sleep(interval,undefined,{signal}).catch(()=>{});
   }}finally{clearInterval(timer);timer=undefined;while(busy)await sleep(10);}
   if(signal?.aborted)break;
   if(lost)throw Error('Heartbeat failed before receipt submission; state retained');
  }
 }finally{if(timer)clearInterval(timer);while(busy)await sleep(10);await release();}
}
