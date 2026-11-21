import {mkdir,open,rename,readFile,lstat,realpath,unlink} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
export class Store {
  constructor(root){this.root=resolve(root);}
  async init(){await mkdir(this.root,{recursive:true,mode:0o700});const s=await lstat(this.root);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error('State directory must be a private 0700 directory, not a symlink');if(await realpath(this.root)!==this.root)throw Error('State directory must not traverse symlinks');}
  path(name){if(!/^[a-z0-9-]+\.json$/.test(name))throw Error('Invalid state name');return join(this.root,name);}
  async read(name){try{const p=this.path(name),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>2*1024*1024)throw Error('Unsafe state file');return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async write(name,data){const target=this.path(name),temp=target+'.'+randomUUID()+'.tmp';const f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(data,null,2)+'\n');await f.sync();}finally{await f.close();}await rename(temp,target);const d=await open(dirname(target),'r');try{await d.sync();}finally{await d.close();}}
  async remove(name){await unlink(this.path(name));}
  async lock(){const p=join(this.root,'run.lock');try{const f=await open(p,'wx',0o600);await f.writeFile(String(process.pid));await f.close();}catch(e){if(e.code==='EEXIST')throw Error('State locked. Confirm previous process is stopped before removing run.lock.');throw e;}return ()=>unlink(p);}
}
