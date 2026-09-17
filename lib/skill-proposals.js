/** Durable skill proposals: content first, human Web apply second. */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  openSync, writeFileSync, fsyncSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fsyncDir, fsyncFile } from './fsync.js';
import { createHash, randomUUID } from 'node:crypto';
import { classifyOwnership } from './skill-ownership.js';

export const SKILL_PROPOSAL_MODES = Object.freeze(['inherit','manual','balanced','autonomous']);
const sha = s => createHash('sha256').update(String(s),'utf8').digest('hex');
const nowIso=()=>new Date().toISOString();

export function resolveSkillProposalMode(cfg={}) {
  const raw=cfg.skillProposalMode??'inherit';
  if(raw!=='inherit'&&SKILL_PROPOSAL_MODES.includes(raw)) return raw;
  return ['manual','balanced','autonomous'].includes(cfg.approvalMode)?cfg.approvalMode:'balanced';
}
export function needsSkillProposal(action,cfg={},hasUsageReceipt=false){
  if(action==='rollback') return true;
  if(['archive','restore'].includes(action)) return false;
  const mode=resolveSkillProposalMode(cfg);
  if(mode!=='autonomous') return true;
  if(['refine','fold','converge'].includes(action)&&!hasUsageReceipt) return true;
  return false;
}

export function canonicalSkillHashes(md){
  const text=String(md??'');
  const m=text.match(/<!--dsh-evolve-state:(.*?)-->/s);
  let state={};try{state=m?JSON.parse(m[1]):{}}catch{state={__malformed:true}}
  const {currentHash,...semantic}=state;
  const content=text.replace(/<!--dsh-evolve-state:.*?-->/s,'').replace(/\s+$/,'');
  return {contentHash:sha(content),stateHash:sha(JSON.stringify(sortObject(semantic)))};
}
function sortObject(v){if(Array.isArray(v))return v.map(sortObject);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortObject(v[k])]));return v}
function safeId(id){if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('unsafe proposal id');return id}

export class ProposalStore{
 constructor({workspaceDir,skillsDir,ownerId}){this.root=join(workspaceDir,'skill-proposals');this.skillsDir=skillsDir;this.ownerId=ownerId}
 dir(id){return join(this.root,safeId(id))}
 create({action,targetSkill,body,description='',tag='',sourceIds=[],originals=[],meta={}}){
  const id=`p_${Date.now().toString(36)}_${randomUUID().slice(0,8)}`;mkdirSync(this.root,{recursive:true});const tmp=`${this.dir(id)}.tmp`;mkdirSync(tmp);
  const bases={};for(const name of new Set([targetSkill,...originals].filter(Boolean))){const p=join(this.skillsDir,name,'SKILL.md');if(existsSync(p))bases[name]=canonicalSkillHashes(readFileSync(p,'utf8'))}
  const proposal={id,action,targetSkill,tag,description,sourceIds:[...sourceIds],originals:[...originals],baseHashes:bases,proposalHash:sha(body),createdAt:nowIso(),updatedAt:nowIso(),state:'pending',meta};
  const md=String(body);writeFileSync(join(tmp,'PROPOSAL.md'),md);writeFileSync(join(tmp,'meta.json'),JSON.stringify(proposal,null,2)+'\n');for(const f of ['PROPOSAL.md','meta.json']){fsyncFile(join(tmp,f))}fsyncDir(tmp);renameSync(tmp,this.dir(id));fsyncDir(this.root);return proposal
 }
 read(id){const d=this.dir(id);if(!existsSync(d))return null;const meta=JSON.parse(readFileSync(join(d,'meta.json'),'utf8'));const body=readFileSync(join(d,'PROPOSAL.md'),'utf8');return{...meta,body}}
 list(state){if(!existsSync(this.root))return[];return readdirSync(this.root).filter(x=>!x.endsWith('.tmp')).map(x=>{try{return this.read(x)}catch{return{id:x,state:'corrupt'}}}).filter(x=>!state||x.state===state)}
 update(id,patch){const cur=this.read(id);if(!cur)throw new Error('proposal not found');const next={...cur,...patch,updatedAt:nowIso()};delete next.body;const p=join(this.dir(id),'meta.json'),tmp=`${p}.tmp`;writeFileSync(tmp,JSON.stringify(next,null,2)+'\n');fsyncFile(tmp);renameSync(tmp,p);fsyncDir(this.dir(id));return next}
 checkBase(proposal){for(const[name,expected]of Object.entries(proposal.baseHashes??{})){const p=join(this.skillsDir,name,'SKILL.md');if(!existsSync(p))return{ok:false,reason:`${name} missing`};const got=canonicalSkillHashes(readFileSync(p,'utf8'));if(got.contentHash!==expected.contentHash||got.stateHash!==expected.stateHash)return{ok:false,reason:`${name} changed`,name,expected,got}}return{ok:true}}
 claim(id,opId){const cur=this.read(id);if(!cur)return{status:'missing'};if(cur.state!=='pending')return{status:cur.state,proposal:cur};let fd;try{fd=openSync(join(this.dir(id),'.claim'),'wx')}catch(e){if(e.code==='EEXIST')return{status:'retry'};throw e}try{writeFileSync(fd,JSON.stringify({opId,pid:process.pid,at:nowIso()}));fsyncSync(fd)}finally{closeSync(fd)}fsyncDir(this.dir(id));this.update(id,{state:'applying',opId,claimedAt:nowIso()});return{status:'acquired',proposal:this.read(id)}}
 finalize(id,opId,state,receipt){const cur=this.read(id);if(!cur||cur.opId!==opId)return{ok:false,reason:'fence mismatch'};const next=this.update(id,{state,receipt});try{rmSync(join(this.dir(id),'.claim'))}catch{}return{ok:true,proposal:{...next,body:cur.body}}}
}
