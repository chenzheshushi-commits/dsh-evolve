import{existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync}from'node:fs';import{writeFileAtomic}from'./atomic-write.js';import{join}from'node:path';import{createHash}from'node:crypto';
const keyOf=(a,t,ids)=>createHash('sha256').update(`${a}\0${t}\0${[...ids].sort().join('\0')}`).digest('hex');
export class EvidenceReservations{
 constructor(workspaceDir){this.path=join(workspaceDir,'.evolve-reservations.json')}
 read(){try{return JSON.parse(readFileSync(this.path,'utf8'))}catch{return{revision:0,entries:{}}}}
 write(v){mkdirSync(join(this.path,'..'),{recursive:true});writeFileAtomic(this.path,JSON.stringify(v,null,2)+'\n',0o600)}
 reserve({action,target,sourceIds,proposalId}){const k=keyOf(action,target,sourceIds),d=this.read();for(const e of Object.values(d.entries))if(e.state==='reserved'&&e.proposalId!==proposalId&&e.ids.some(id=>sourceIds.includes(id)))return{ok:false,reason:'evidence already reserved'};d.entries[k]={proposalId,ids:[...sourceIds].sort(),reservedAt:new Date().toISOString(),state:'reserved'};d.revision+=1;this.write(d);return{ok:true,key:k,revision:d.revision}}
 release(proposalId){const d=this.read();let n=0;for(const[k,e]of Object.entries(d.entries))if(e.proposalId===proposalId&&e.state==='reserved'){delete d.entries[k];n++}if(n){d.revision++;this.write(d)}return n}
 consume(proposalId){const d=this.read();let n=0;for(const e of Object.values(d.entries))if(e.proposalId===proposalId&&e.state==='reserved'){e.state='consumed';e.consumedAt=new Date().toISOString();n++}if(n){d.revision++;this.write(d)}return n}
}
