import{randomUUID}from'node:crypto';
export class UsageReceiptStore{
 constructor({ttlMs=30*60*1000,now=()=>Date.now()}={}){this.ttlMs=ttlMs;this.now=now;this.byId=new Map()}
 issue({sessionId,turn,callId,skillName}){if(!sessionId||!callId||!skillName)return null;const r={receiptId:`ur_${randomUUID()}`,sessionId:String(sessionId),turn:Number(turn??0),callId:String(callId),skillName,success:true,createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+this.ttlMs).toISOString(),consumedAt:null};this.byId.set(r.receiptId,r);return r}
 available(skillName,sessionId){const now=this.now();return[...this.byId.values()].filter(r=>r.skillName===skillName&&r.sessionId===String(sessionId)&&!r.consumedAt&&Date.parse(r.expiresAt)>now)}
 consume(receiptId,opId){const r=this.byId.get(receiptId);if(!r||r.consumedAt||Date.parse(r.expiresAt)<=this.now())return{ok:false};const n={...r,consumedAt:new Date(this.now()).toISOString(),consumedByOpId:opId};this.byId.set(receiptId,n);return{ok:true,receipt:n}}
}
