import{createHash,randomUUID}from'node:crypto';
export const ACTION_CAP_SPECS=Object.freeze({
 'proposal-apply':t=>({proposalId:t.proposalId,proposalHash:t.proposalHash,baseHashes:t.baseHashes}),
 'proposal-reject':t=>({proposalId:t.proposalId,proposalHash:t.proposalHash,baseHashes:t.baseHashes}),
 'legacy-claim':t=>({name:t.name,contentHash:t.contentHash,stateHash:t.stateHash}),
 'memory-discard':t=>({ids:[...(t.ids??[])].sort()}),
 'memory-restore-rejected':t=>({ids:[...(t.ids??[])].sort()}),
});
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v}
export function buildCanonicalDigest(purpose,target){const fn=ACTION_CAP_SPECS[purpose];if(!fn)throw new Error('unknown capability purpose');return createHash('sha256').update(JSON.stringify(canonical(fn(target)))).digest('hex')}
export class CapabilityStore{
 constructor({ttlMs=5*60*1000,now=()=>Date.now()}={}){this.ttlMs=ttlMs;this.now=now;this.map=new Map()}
 mint({purpose,target,sessionKey,fetchSite}){const capId=`cap_${randomUUID()}`,digest=buildCanonicalDigest(purpose,target),expiresAt=this.now()+this.ttlMs;this.map.set(capId,{capId,purpose,digest,sessionKey,fetchSite,expiresAt,consumedBy:null});return{capId,expiresAt:new Date(expiresAt).toISOString()}}
 consume({capId,purpose,target,sessionKey,fetchSite,opId}){const c=this.map.get(capId);if(!c||c.consumedBy)return{ok:false,code:401,error:'capability-consumed-or-unknown'};if(c.expiresAt<=this.now())return{ok:false,code:401,error:'capability-expired'};if(c.purpose!==purpose)return{ok:false,code:403,error:'capability-wrong-purpose'};const d=buildCanonicalDigest(purpose,target);if(c.digest!==d||c.sessionKey!==sessionKey||c.fetchSite!==fetchSite)return{ok:false,code:403,error:'capability-target-or-session-mismatch'};c.consumedBy=opId;return{ok:true}}
}
