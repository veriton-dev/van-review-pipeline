import {NETWORK,ENVIRONMENT,AUTHORIZATION_DOMAIN} from './network.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {canonical} from './canonical.mjs';
import {TEST_ORIGIN,ApiError} from './api.mjs';
import {uuid} from './reviewer.mjs';
export const ASSET=NETWORK.asset;
export const TARIFF='buyer-budget-68-17-15-v1';
const address=v=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v)&&!/^0x0{40}$/i.test(v);
export const atomic=v=>{if(typeof v!=='string'||!/^[1-9][0-9]{0,12}$/.test(v)||BigInt(v)>1000000000000n)throw Error('Invalid atomic USDC amount');return BigInt(v);};
export const sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function policy(p){if(!p||Object.keys(p).sort().join(',')!=='maxOrderAtomic,maxTotalAtomic,treasury,wallet'||!address(p.wallet)||!address(p.treasury)||atomic(p.maxOrderAtomic)>atomic(p.maxTotalAtomic)||(ENVIRONMENT==='mainnet'&&(atomic(p.maxOrderAtomic)>1000000n||atomic(p.maxTotalAtomic)>4000000n)))throw Error('Invalid buyer policy');return {...p,wallet:p.wallet.toLowerCase(),treasury:p.treasury.toLowerCase()};}
export function brief(input){
 if(!input||Object.keys(input).some(k=>!['brief','language','acceptanceCriteria','publicListing','budgetAtomic','visibility','platformCriteria'].includes(k))||typeof input.brief!=='string'||!input.brief.trim()||typeof input.language!=='string'||!input.language.trim()||input.language.length>64||input.visibility!=='public'||!Array.isArray(input.acceptanceCriteria)||input.acceptanceCriteria.length>6||input.acceptanceCriteria.some(x=>typeof x!=='string'||!x.trim()))throw Error('Invalid public buyer brief');
 atomic(input.budgetAtomic);const p=input.publicListing,text=(v,n)=>typeof v==='string'&&v.trim()&&v.length<=n&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
 if(!p||Object.keys(p).sort().join(',')!=='deliverables,requiredSkills,summary,title'||!text(p.title,120)||!text(p.summary,1200)||!Array.isArray(p.requiredSkills)||p.requiredSkills.length>10||p.requiredSkills.some(x=>!text(x,64))||!Array.isArray(p.deliverables)||p.deliverables.length<1||p.deliverables.length>6||p.deliverables.some(x=>!text(x,240)))throw Error('Explicit public listing required');
 const platformCriteria=['Material factual claims are supported by cited sources'];if(input.platformCriteria!==undefined&&canonical(input.platformCriteria)!==canonical(platformCriteria))throw Error('Unexpected platform criteria');
 const out={brief:input.brief,language:input.language,acceptanceCriteria:input.acceptanceCriteria,publicListing:p,budgetAtomic:input.budgetAtomic,visibility:'public',platformCriteria};if(Buffer.byteLength(canonical(out))>16384)throw Error('Brief too large');return out;
}
export function validateQuote(response,order,p,me,now=Date.now()){
 const q=response.body?.quote;let challenge;if(typeof response.paymentRequired!=='string'||response.paymentRequired.length>16384)throw Error('Invalid x402 challenge');try{challenge=JSON.parse(Buffer.from(response.paymentRequired??'','base64').toString('utf8'));}catch{throw Error('Invalid x402 challenge');}
 if(response.status!==402||response.body.status!=='awaiting_payment'||!q||Object.keys(q).sort().join(',')!==(ENVIRONMENT==='mainnet'?'asset,briefHash,budgetAtomic,buyerId,chainId,environmentId,expiresAt,jobId,payTo,protocolAtomic,resource,reviewerAtomic,tariffVersion,version,workerAtomic':'asset,briefHash,budgetAtomic,buyerId,chainId,expiresAt,jobId,payTo,protocolAtomic,resource,reviewerAtomic,version,workerAtomic')||!uuid(q.jobId)||q.jobId!==response.body.jobId||q.buyerId!==me.agentId||q.briefHash!==sha(order.brief)||q.budgetAtomic!==order.brief.budgetAtomic||(ENVIRONMENT==='mainnet'?(q.version!=='van-budget-quote-v2'||q.environmentId!=='mainnet'||q.tariffVersion!==TARIFF):q.version!==TARIFF)||q.chainId!==NETWORK.chainId||q.asset!==ASSET||q.payTo!==p.treasury||q.resource!==TEST_ORIGIN+'/jobs/'+q.jobId||response.body.timingVersion!==2||response.body.quoteExpiresAt!==q.expiresAt||!Number.isFinite(Date.parse(q.expiresAt))||Date.parse(q.expiresAt)<=now+10000||Date.parse(q.expiresAt)>now+610000||response.body.quoteHash!=='0x'+sha(q))throw Error('Unexpected frozen quote');
 const amount=atomic(q.budgetAtomic),fee=amount*15n/100n,review=(amount-fee)*20n/100n;
 if(fee.toString()!==q.protocolAtomic||review<=0n||review.toString()!==q.reviewerAtomic||(amount-fee-review).toString()!==q.workerAtomic||amount>atomic(p.maxOrderAtomic))throw Error('Unexpected quote allocation');
 const offer=challenge.accepts?.[0];
 if(challenge.x402Version!==2||challenge.accepts?.length!==1||challenge.resource?.url!==q.resource||Object.keys(challenge.resource).join(',')!=='url'||!offer||Object.keys(offer).sort().join(',')!=='amount,asset,extra,maxTimeoutSeconds,network,payTo,scheme'||offer.scheme!=='exact'||offer.network!==NETWORK.network||offer.asset.toLowerCase()!==ASSET||offer.payTo.toLowerCase()!==p.treasury||offer.amount!==q.budgetAtomic||canonical(offer.extra)!==canonical(AUTHORIZATION_DOMAIN)||!Number.isInteger(offer.maxTimeoutSeconds)||offer.maxTimeoutSeconds<1||offer.maxTimeoutSeconds>600)throw Error('Unexpected x402 payment requirements');
 return {quote:q,quoteHash:'0x'+sha(q),challenge,offer};
}
export function signingRequest(validated,p){
 const authorization={from:p.wallet,to:validated.quote.payTo,value:validated.quote.budgetAtomic,validAfter:'0',validBefore:String(Math.floor(Date.parse(validated.quote.expiresAt)/1000)-2),nonce:validated.quoteHash};
 return {quoteHash:validated.quoteHash,domain:{...AUTHORIZATION_DOMAIN,chainId:NETWORK.chainId,verifyingContract:ASSET},primaryType:'TransferWithAuthorization',types:{TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},message:authorization};
}
async function identity(client,p){const me=await client.me();if(me.role!=='buyer'||me.wallet?.toLowerCase()!==p.wallet||!uuid(me.agentId))throw Error('Buyer identity/policy mismatch');return me;}
export async function quoteOrder(client,store,label,input,policyInput){
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label))throw Error('Use an order name with lowercase letters, digits and dashes');
 const normalized=brief(input),p=policy(policyInput),unlock=await store.lock();
 try{
  const me=await identity(client,p);let ledger=await store.read('buyer-ledger.json');
  if(!ledger){ledger={policy:p,buyerId:me.agentId,reservedAtomic:'0',orders:{}};}
  if(canonical(ledger.policy)!==canonical(p)||ledger.buyerId!==me.agentId)throw Error('Buyer policy is immutable in this state directory');
  let o=Object.hasOwn(ledger.orders,label)?ledger.orders[label]:undefined;if(o&&canonical(o.brief)!==canonical(normalized))throw Error('Order name is bound to a different brief');
  if(!o){const amount=atomic(normalized.budgetAtomic);if(amount>atomic(p.maxOrderAtomic)||BigInt(ledger.reservedAtomic)+amount>atomic(p.maxTotalAtomic))throw Error('Buyer spending cap exceeded');o={brief:normalized,idempotencyKey:'connector-'+randomUUID()};ledger.orders[label]=o;ledger.reservedAtomic=String(BigInt(ledger.reservedAtomic)+amount);await store.write('buyer-ledger.json',ledger);}
  if(o.validated){validateQuote({status:402,body:{status:'awaiting_payment',jobId:o.validated.quote.jobId,timingVersion:2,quoteExpiresAt:o.validated.quote.expiresAt,quote:o.validated.quote,quoteHash:o.validated.quoteHash},paymentRequired:Buffer.from(JSON.stringify(o.validated.challenge)).toString('base64')},o,p,me);await store.write('buyer-signing-'+label+'.json',o.signing);return {jobId:o.validated.quote.jobId,quoteHash:o.validated.quoteHash,quote:o.validated.quote,signingFile:store.path('buyer-signing-'+label+'.json')};}
  const r=await client.exchange('/jobs',o.brief,{headers:{'Idempotency-Key':o.idempotencyKey}});
  o.validated=validateQuote(r,o,p,me);o.signing=signingRequest(o.validated,p);await store.write('buyer-ledger.json',ledger);await store.write('buyer-signing-'+label+'.json',o.signing);
  return {jobId:o.validated.quote.jobId,quoteHash:o.validated.quoteHash,quote:o.validated.quote,signingFile:store.path('buyer-signing-'+label+'.json')};
 }finally{await unlock();}
}
export async function payOrder(client,store,label,approvedHash,signatureInput){
 const unlock=await store.lock();try{
  const ledger=await store.read('buyer-ledger.json'),o=ledger?.orders?.[label];if(!o?.validated)throw Error('Obtain and inspect a quote first');
  const p=policy(ledger.policy),me=await identity(client,p);if(ledger.buyerId!==me.agentId)throw Error('Stored buyer identity changed');
  const valid=validateQuote({status:402,body:{status:'awaiting_payment',jobId:o.validated.quote.jobId,timingVersion:2,quoteExpiresAt:o.validated.quote.expiresAt,quote:o.validated.quote,quoteHash:o.validated.quoteHash},paymentRequired:Buffer.from(JSON.stringify(o.validated.challenge)).toString('base64')},o,p,me,Math.min(Date.now(),Date.parse(o.validated.quote.expiresAt)-11000));
  if(canonical(o.signing)!==canonical(signingRequest(valid,p)))throw Error('Stored signing domain changed');
  if(approvedHash!==o.validated.quoteHash)throw Error('Explicit exact quote approval required');
  if(!o.payment){
   if(Date.now()>=Date.parse(o.validated.quote.expiresAt)-2000)throw Error('Quote expired; no fresh signature/payment will be generated');
   if(!signatureInput||Object.keys(signatureInput).sort().join(',')!=='quoteHash,signature'||signatureInput.quoteHash!==approvedHash||!/^0x[0-9a-fA-F]{130}$/.test(signatureInput.signature))throw Error('Expected {quoteHash,signature} from your local EIP-712 signer');
   // Build payment ourselves; an external signer supplies only a signature.
   o.payment=Buffer.from(JSON.stringify({x402Version:2,resource:o.validated.challenge.resource,accepted:o.validated.offer,payload:{authorization:o.signing.message,signature:signatureInput.signature}})).toString('base64');
   await store.write('buyer-ledger.json',ledger);
  }else if(signatureInput&&signatureInput.signature!==JSON.parse(Buffer.from(o.payment,'base64')).payload.signature)throw Error('Payment already frozen; replacement signatures are refused');
  const r=await client.exchange('/jobs',o.brief,{headers:{'Idempotency-Key':o.idempotencyKey,'PAYMENT-SIGNATURE':o.payment}});
  if(r.body?.jobId!==o.validated.quote.jobId)throw Error('Paid order identity changed; reconcile');
  o.lastResponse={status:r.status,body:r.body};await store.write('buyer-ledger.json',ledger);
  if(![200,202].includes(r.status))throw new ApiError(r.status,r.body?.error??'payment_reconciliation_required');
  return {jobId:r.body.jobId,status:r.body.status,note:'Acknowledgement is not proof of confirmed payment. Use buyer-status.'};
 }finally{await unlock();}
}
