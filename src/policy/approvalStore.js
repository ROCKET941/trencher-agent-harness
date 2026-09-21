import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const blank=()=>({version:1,approvals:{}})
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback

export function approvalFile(env=process.env){
  if(String(env.HARNESS_APPROVAL_FILE||'').trim())return path.resolve(String(env.HARNESS_APPROVAL_FILE).trim())
  const stateFile=path.resolve(String(env.HARNESS_STATE_FILE||path.join(process.cwd(),'.state','accounting.json')))
  return path.join(path.dirname(stateFile),'approvals.json')
}

export class ApprovalStore{
  #tail=Promise.resolve()
  constructor({file,env=process.env,now=()=>Date.now()}={}){this.env=env;this.file=file||approvalFile(env);this.now=now}
  async #load(){try{return JSON.parse(await readFile(this.file,'utf8'))}catch(error){if(error.code==='ENOENT')return blank();throw error}}
  async #save(state){await mkdir(path.dirname(this.file),{recursive:true});const temp=`${this.file}.${process.pid}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(state,null,2),{encoding:'utf8',mode:0o600});await rename(temp,this.file)}
  async #fileLock(operation){
    await mkdir(path.dirname(this.file),{recursive:true});const lock=`${this.file}.lock`,started=Date.now(),timeout=positive(this.env.HARNESS_APPROVAL_LOCK_TIMEOUT_MS,5000)
    while(true){
      try{await mkdir(lock);break}catch(error){
        if(error.code!=='EEXIST')throw error
        if(Date.now()-started>=timeout)throw new Error('approval-store-lock-timeout')
        await delay(25)
      }
    }
    try{return await operation()}finally{await rm(lock,{recursive:true,force:true})}
  }
  #locked(operation){const next=this.#tail.then(()=>this.#fileLock(operation),()=>this.#fileLock(operation));this.#tail=next.catch(()=>{});return next}
  issue({action,scope,reason,approvedBy='owner',ttlSeconds}={}){return this.#locked(async()=>{
    const normalizedAction=String(action||'').trim(),normalizedScope=String(scope||'').trim(),normalizedReason=String(reason||'').trim(),actor=String(approvedBy||'owner').trim().slice(0,120)
    if(!normalizedAction)throw new Error('approval action is required')
    if(!normalizedScope||normalizedScope.length>500)throw new Error('approval scope is required and must be <= 500 characters')
    if(!normalizedReason||normalizedReason.length>500)throw new Error('approval reason is required and must be <= 500 characters')
    const maximum=Math.min(3600,Math.trunc(positive(this.env.HARNESS_APPROVAL_MAX_TTL_SECONDS,900))),ttl=Math.min(maximum,Math.max(30,Math.trunc(positive(ttlSeconds,600)))),now=this.now(),id=`approval_${randomUUID().replaceAll('-','')}`
    const record={id,action:normalizedAction,scope:normalizedScope,reason:normalizedReason,approvedBy:actor,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+ttl*1000).toISOString(),status:'pending',consumedAt:null}
    const state=await this.#load();state.approvals[id]=record;await this.#save(state);return structuredClone(record)
  })}
  consume({id,action,scope}={}){return this.#locked(async()=>{
    const state=await this.#load(),record=state.approvals[String(id||'')]
    const deny=reason=>({allowed:false,reason,approvalId:String(id||'')||null})
    if(!record)return deny('trusted-host-approval-not-found')
    if(record.action!==String(action||'').trim()||record.scope!==String(scope||'').trim())return deny('trusted-host-approval-scope-mismatch')
    if(record.status==='consumed')return deny('trusted-host-approval-already-consumed')
    if(record.status!=='pending')return deny('trusted-host-approval-unavailable')
    if(Date.parse(record.expiresAt)<=this.now()){record.status='expired';await this.#save(state);return deny('trusted-host-approval-expired')}
    record.status='consumed';record.consumedAt=new Date(this.now()).toISOString();await this.#save(state)
    return{allowed:true,reason:'trusted-host-authorization',approvalId:record.id,action:record.action,scope:record.scope,approvedBy:record.approvedBy,expiresAt:record.expiresAt,oneTime:true,evidenceSource:'trusted-host-ledger'}
  })}
}

const stores=new Map()
export function getApprovalStore(env=process.env){const file=approvalFile(env);if(!stores.has(file))stores.set(file,new ApprovalStore({file,env}));return stores.get(file)}
