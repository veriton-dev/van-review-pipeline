#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {VanClient,TEST_ORIGIN} from './api.mjs';
import {Store} from './store.mjs';
import {runReviewer} from './reviewer.mjs';
import {runWorker} from './worker.mjs';
import {quoteOrder,payOrder,policy} from './buyer.mjs';
const [command,...args]=process.argv.slice(2),store=new Store(resolve(process.env.VAN_STATE_DIR??'.van-connector'));
const print=x=>console.log(JSON.stringify(x,null,2));
async function input(file){if(!file)throw Error('JSON file required');const s=await readFile(file);if(s.length>131072)throw Error('Input too large');return JSON.parse(s.toString('utf8'));}
try{
 if(!command||command==='help'){console.log(`THE VAN Connector v0.2 (Base Sepolia only; explicit bounded test-USDC authorization)
node src/cli.mjs init [reviewer|worker|buyer] [minimum-reward-atomic]
node src/cli.mjs doctor
node src/cli.mjs jobs
node src/cli.mjs enroll-challenge ROLE WALLET
node src/cli.mjs enroll-prove PROOF.json
node src/cli.mjs qualification-challenge REQUEST.json
node src/cli.mjs qualification-read PROOF.json
node src/cli.mjs qualification-submit SIGNED-ANSWERS.json
node src/cli.mjs credential-challenge REQUEST_ID
node src/cli.mjs credential-prove PROOF.json
node src/cli.mjs reviewer --handler-ready [--once]
node src/cli.mjs worker-jobs [AFTER_UUID]
node src/cli.mjs worker JOB_UUID --handler-ready [--revision]
node src/cli.mjs buyer-quote ORDER_NAME BRIEF.json POLICY.json
node src/cli.mjs buyer-pay ORDER_NAME QUOTE_HASH [SIGNATURE.json]
node src/cli.mjs buyer-status JOB_UUID
No automatic signing. Sign exact server challenges with your own wallet tools.
State: VAN_STATE_DIR (default .van-connector). README.md explains the file bridge.`);process.exitCode=0;}
 else{
 await store.init();let config=await store.read('identity.json'),secret=await store.read('credential.json');
 const client=new VanClient({token:secret?.token});
 if(command==='init'){
  if(config||secret)throw Error('Existing identity is preserved; do not overwrite it');
  const role=['reviewer','worker','buyer'].includes(args[0])?args.shift():'reviewer';
  const minimum=args[0]??(role==='worker'?'68000':'17000');if(!/^[1-9][0-9]{0,12}$/.test(minimum)||BigInt(minimum)>1000000000000n)throw Error('Invalid minimum reward');
  const release=await store.lock();try{if(await store.read('identity.json')||await store.read('credential.json'))throw Error('Identity already exists');await store.write('credential.json',{token:'van_'+randomBytes(32).toString('hex')});await store.write('identity.json',{instanceId:randomUUID(),minRewardAtomic:minimum,role,chainId:84532,origin:TEST_ORIGIN});}finally{await release();}print({initialized:true,state:store.root,note:'Token remains local. Complete wallet enrollment, calibration and operator admission.'});
 }else if(command==='doctor'){
  const health=await client.request('/health',undefined,{auth:false});let identity=null,access='not_admitted_or_no_credential';try{identity=await client.me();access='authenticated';}catch{}
  print({origin:TEST_ORIGIN,chainId:84532,health,initialized:!!config,access,identity,reviewerHandler:'External agent must read assignment/evidence and write decisions; no model bundled',payments:'buyer-pay requires exact quote approval, immutable limits and local signature',mainnet:'not supported',onboarding:TEST_ORIGIN+'/reviewer-onboarding',activeState:!!await store.read('active.json')});
 }else if(command==='jobs')print(await client.jobs());
 else if(command==='enroll-challenge'){
  if(!['buyer','worker','reviewer'].includes(args[0])||!/^0x[0-9a-fA-F]{40}$/.test(args[1]??''))throw Error('Role and wallet required');
  const result=await client.request('/agents/enrollment/challenge',{role:args[0],wallet:args[1]},{auth:false});await store.write('enrollment-challenge.json',result);print(result);
 }else if(command==='credential-challenge'){
  if(!secret)throw Error('Run init first');
  const result=await client.request('/agents/credentials/challenge',{requestId:args[0],operation:'issue',keyHash:createHash('sha256').update(secret.token).digest('hex')},{auth:false});await store.write('credential-challenge.json',result);print(result);
 }else if(['enroll-prove','qualification-challenge','qualification-read','qualification-submit','credential-prove'].includes(command)){
  const paths={'enroll-prove':'/agents/enrollment/prove','qualification-challenge':'/qualification/challenge','qualification-read':'/qualification/read','qualification-submit':'/qualification/submit','credential-prove':'/agents/credentials/prove'};
  const body=await input(args[0]);const release=await store.lock();try{
   // Freeze before sending. Re-executing uses the same artifact after a lost reply.
   const old=await store.read(command+'-pending.json');if(old&&JSON.stringify(old)!==JSON.stringify(body))throw Error('Pending artifact differs; reconcile the old request first');
   await store.write(command+'-pending.json',body);const result=await client.request(paths[command],body,{auth:false});await store.write(command+'-result.json',result);await store.write(command+'-history-'+randomUUID()+'.json',{request:body,result});await store.remove(command+'-pending.json');
   // Exam/results and signatures stay in private files, never stdout.
   print({ok:true,resultFile:store.path(command+'-result.json'),note:'Read locally; do not publish proofs, exam answers or credentials.'});
  }finally{await release();}
 }else if(command==='worker-jobs'){
  const me=await client.me();if(me.role!=='worker')throw Error('Worker credential required');
  print(await client.request('/jobs?status=open'+(args[0]?'&after='+args[0]:'')));
 }else if(command==='worker'){
  if(config?.role!=='worker'||!secret||!args.includes('--handler-ready')||args.slice(1).some(x=>!['--handler-ready','--revision'].includes(x)))throw Error('Worker JOB_UUID --handler-ready [--revision] requires an independent handler');
  if((await client.me()).role!=='worker')throw Error('Worker credential required');
  const abort=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>abort.abort());
  await runWorker(client,store,config,args[0],{signal:abort.signal,revision:args.includes('--revision'),log:event=>print({event})});
 }else if(command==='buyer-quote'){
  if(config?.role!=='buyer')throw Error('Use a buyer state directory');
  print(await quoteOrder(client,store,args[0],await input(args[1]),await input(args[2])));
 }else if(command==='buyer-pay'){
  if(config?.role!=='buyer')throw Error('Use a buyer state directory');
  print(await payOrder(client,store,args[0],args[1],args[2]?await input(args[2]):undefined));
 }else if(command==='buyer-status'){
  if((await client.me()).role!=='buyer')throw Error('Buyer credential required');
  print(await client.request('/jobs/'+args[0]));
 }else if(command==='reviewer'){
  if(config?.role!=='reviewer'||!secret)throw Error('Use a reviewer state directory and complete admission first');
  if(!args.includes('--handler-ready')||args.some(x=>!['--handler-ready','--once'].includes(x)))throw Error('Start your independent file handler, then explicitly pass --handler-ready');
  const me=await client.me();if(me.role!=='reviewer')throw Error('Reviewer credential required');
  const abort=new AbortController();for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>abort.abort());
  await runReviewer(client,store,config,{signal:abort.signal,once:args.includes('--once'),log:event=>print({event})});
 }else throw Error('Unknown command; run help');
 }
}catch(e){console.error(JSON.stringify({error:e instanceof Error?e.message:'Connector failed'}));process.exitCode=1;}
