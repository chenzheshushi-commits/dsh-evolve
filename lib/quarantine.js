import{existsSync,readFileSync,readdirSync}from'node:fs';import{join}from'node:path';
export class QuarantineService{
 constructor({workspaceDir,proposalStore,ttlMs=10*60*1000,now=()=>Date.now()}){this.dir=join(workspaceDir,'secret-incidents');this.proposals=proposalStore;this.ttlMs=ttlMs;this.now=now;this.candidates=new Map()}
 list(){if(!existsSync(this.dir))return[];return readdirSync(this.dir).filter(f=>f.endsWith('.json')).map(f=>{try{const x=JSON.parse(readFileSync(join(this.dir,f),'utf8'));return{incidentId:x.incidentId,patternName:x.patternName,maskedSnippet:x.maskedSnippet,sourceIds:x.sourceIds??[],at:x.at}}catch{return null}}).filter(Boolean)}
 regenerate(id){const inc=this.list().find(x=>x.incidentId===id);if(!inc)return{ok:false,status:404,error:'incident-not-found'};const candidateId=`qc_${this.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;const expiresAt=this.now()+this.ttlMs;
  // The raw body was intentionally never persisted. Regeneration is therefore a
  // new proposal skeleton from source ids, not a release of old secret bytes.
  const maskedPreview=`Regenerate a new skill proposal from source memories: ${inc.sourceIds.join(', ')}`;
  const c={candidateId,incidentId:id,contentHash:inc.incidentId,maskedPreview,expiresAt,scannerVersion:'1',normalizationVersion:'1',incidentRevision:1,sourceIds:inc.sourceIds,canonicalOccurrences:[]};this.candidates.set(candidateId,c);return{ok:true,...c,expiresAt:new Date(expiresAt).toISOString()}}
 apply(id,candidateId){const c=this.candidates.get(candidateId);if(!c||c.incidentId!==id||c.expiresAt<=this.now())return{ok:false,status:409,error:'candidate-expired-or-mismatch'};this.candidates.delete(candidateId);const p=this.proposals.create({action:'crystallize',targetSkill:`regenerated-${id.slice(-8)}`,tag:'quarantine-regenerated',body:c.maskedPreview,sourceIds:c.sourceIds,meta:{regeneratedFromIncident:id}});return{ok:true,newProposalId:p.id}}
}
