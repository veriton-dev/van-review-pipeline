import {NETWORK} from './network.mjs';
import {TEST_ORIGIN} from './api.mjs';
import {canonical} from './canonical.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const prefix='THE VAN qualification read only. This signature does not authorize payments or grant marketplace access.\n\n';
export function validateCalibrationChallenge(ch,requestId,operation,now=Date.now()){
 if(!ch||ch.signingMethod!=='personal_sign'||ch.accessGranted!==false||!uuid(ch.challengeId)||
   typeof ch.message!=='string'||!ch.message.startsWith(prefix))throw Error('Invalid calibration signing request');
 let p;try{p=JSON.parse(ch.message.slice(prefix.length));}catch{throw Error('Invalid calibration signing request');}
 if(!p||Object.keys(p).sort().join(',')!=='action,audience,chainId,challengeId,examId,expiresAt,operation,requestId'||
   p.action!=='van.qualification-read.v1'||p.audience!==TEST_ORIGIN||p.chainId!==NETWORK.chainId||
   p.requestId!==requestId||p.operation!==operation||p.challengeId!==ch.challengeId||!uuid(p.examId)||
   !Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)!==Date.parse(ch.expiresAt)||
   Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>now+330000||
   ch.message!==prefix+canonical(p))throw Error('Invalid calibration signing context');
 return ch;
}
// Read-only API requests only; signing remains with the agent's own wallet tool.
export async function calibrationChallenge(client,store,operation){
 if(!['exam','result'].includes(operation))throw Error('Choose exam or result');
 const release=await store.lock();try{
  const enrollment=await store.read('enroll-prove-result.json');
  if(!uuid(enrollment?.requestId)||enrollment.role!=='reviewer'||
    !['pending','admitted'].includes(enrollment.status))throw Error('A saved reviewer enrollment result is required; existing identities can use qualification-challenge');
  const name='calibration-'+operation+'-challenge.json',old=await store.read(name);
  if(old&&Date.parse(old.expiresAt)>Date.now())return {challenge:validateCalibrationChallenge(old,enrollment.requestId,operation),file:store.path(name),reused:true};
  const ch=validateCalibrationChallenge(await client.request('/qualification/challenge',
    {requestId:enrollment.requestId,operation},{auth:false}),enrollment.requestId,operation);
  await store.write(name,ch);
  return {challenge:ch,file:store.path(name),reused:false};
 }finally{await release();}
}
