import {NETWORK,ENVIRONMENT,validateDescriptor,validateDeploymentDescriptor} from './network.mjs';
export const API_ORIGIN=NETWORK.audience;
export const TEST_ORIGIN=API_ORIGIN; // compatibility export; selected network is immutable for the process
export class ApiError extends Error {
  constructor(status, code, details) { super(`VAN HTTP ${status}: ${/^[a-z_]{1,80}$/.test(code) ? code : 'request_failed'}`); this.status=status; this.code=code; this.details=details; }
}
function apiPath(path) {
  const [base,query,...rest]=path.split('?');
  if(rest.length||!/^\/(?:health(?:\/ready)?|\.well-known\/van-(?:network|deployment)\.json|public\/jobs(?:\/[a-f0-9-]{36})?|agents\/(?:me|enrollment\/(?:challenge|prove)|credentials\/(?:challenge|prove)|instances\/heartbeat)|qualification\/(?:challenge|read|submit)|reviews\/(?:heartbeat|next)|jobs(?:\/[a-f0-9-]{36}(?:\/(?:claim|heartbeat|submit|revision|assignment|review(?:\/(?:claim|heartbeat|evidence|citation-check))?))?)?)$/.test(base))throw Error('Unsupported API path');
  if(query!==undefined){const p=new URLSearchParams(query);if(base!=='/jobs'||p.get('status')!=='open'||[...p.keys()].some(k=>!['status','after'].includes(k))||new Set(p.keys()).size!==[...p.keys()].length||(p.has('after')&&!/^[a-f0-9-]{36}$/.test(p.get('after'))))throw Error('Unsupported API query');}
  return path;
}
export class VanClient {
  constructor({token, fetchImpl=fetch}={}) { this.token=token; this.fetch=fetchImpl; }
  async context(){
    if(!this.contextCheck)this.contextCheck=this.#transport('/.well-known/van-network.json',undefined,{auth:false}).then(async r=>{
      if(r.status!==200)throw Error('Server network description unavailable; no credential or payment sent');
      validateDescriptor(r.body);
      if(ENVIRONMENT==='mainnet'){const d=await this.#transport('/.well-known/van-deployment.json',undefined,{auth:false});if(d.status!==200)throw Error('Server deployment description unavailable');validateDeploymentDescriptor(d.body);}
      return r.body;
    }).catch(e=>{this.contextCheck=undefined;throw e;});
    return this.contextCheck;
  }
  async exchange(path,body,options={}){
    apiPath(path);
    if(options.auth!==false&&!/^van_[a-f0-9]{64}$/.test(this.token??''))throw Error('Local API token required; complete enrollment/admission first');
    await this.context();return this.#transport(path,body,options);
  }
  async #transport(path, body, {auth=true,headers={}}={}) {
    apiPath(path);
    if(auth&&!/^van_[a-f0-9]{64}$/.test(this.token??''))throw Error('Local API token required; complete enrollment/admission first');
    for(const [k,v] of Object.entries(headers))if(!['Idempotency-Key','PAYMENT-SIGNATURE'].includes(k)||typeof v!=='string'||/[\r\n]/.test(v)||v.length>(k==='Idempotency-Key'?128:16384))throw Error('Unsupported request header');
    const r=await this.fetch(TEST_ORIGIN+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+this.token}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const reader=r.body?.getReader();let size=0,chunks=[];
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('API response too large');}chunks.push(value);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid API response');}
    return {status:r.status,body:data,paymentRequired:r.headers.get('PAYMENT-REQUIRED')};
  }
  async request(path,body,options){const r=await this.exchange(path,body,options);if(r.status<200||r.status>=300)throw new ApiError(r.status,r.body?.error,r.body);return r.body;}
  jobs(){return this.request('/public/jobs',undefined,{auth:false});}
  me(){return this.request('/agents/me');}
}
