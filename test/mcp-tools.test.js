import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  routeTask, buildEvidencePacket, checkContinue, checkAction,
  createDelegationRequest, reviewRoute
} from '../src/mcp/tools.js'
import { ApprovalStore } from '../src/policy/approvalStore.js'

test('route_task selects scout for retrieval', async () => {
  const result = await routeTask({ task: 'Find callers of reconcileSwapFill' }, { useJev: false })
  assert.equal(result.route.role, 'scout')
})

test('build_evidence_packet enforces context bounds', () => {
  const files = Array.from({ length: 10 }, (_, i) => `f${i}.js`)
  const { packet } = buildEvidencePacket({ task: 'x', files })
  assert.equal(packet.files.length, 6)
})

test('check_continue blocks a second attempt without evidence', () => {
  assert.equal(checkContinue({ attempts: [{}], newEvidence: false }).allowed, false)
})

test('check_action blocks deployment without authorization', async () => {
  assert.equal((await checkAction({ action: 'deploy' })).allowed, false)
})

test('trusted-host deployment approval is scoped, expiring and one-time',async()=>{
  let now=Date.parse('2026-09-21T00:00:00Z')
  const directory=await mkdtemp(path.join(os.tmpdir(),'harness-approval-')),env={HARNESS_ENABLE_TRUSTED_APPROVALS:'true'},approvalStore=new ApprovalStore({file:path.join(directory,'approvals.json'),env,now:()=>now})
  const record=await approvalStore.issue({action:'deploy',scope:'production:trade-page:abc123',reason:'owner approved exact release',ttlSeconds:60})
  assert.equal((await checkAction({action:'deploy',approval:{id:record.id,scope:'production:other'}},{env,approvalStore})).reason,'trusted-host-approval-scope-mismatch')
  const allowed=await checkAction({action:'deploy',approval:{id:record.id,scope:record.scope}},{env,approvalStore})
  assert.equal(allowed.allowed,true);assert.equal(allowed.oneTime,true);assert.equal(allowed.evidenceSource,'trusted-host-ledger')
  assert.equal((await checkAction({action:'deploy',approval:{id:record.id,scope:record.scope}},{env,approvalStore})).reason,'trusted-host-approval-already-consumed')
  const expired=await approvalStore.issue({action:'deploy',scope:'production:trade-page:def456',reason:'owner approved exact release',ttlSeconds:30});now+=31_000
  assert.equal((await checkAction({action:'deploy',approval:{id:expired.id,scope:expired.scope}},{env,approvalStore})).reason,'trusted-host-approval-expired')
})

test('trusted-host approvals are disabled by default and cannot bypass commit or retry policy',async()=>{
  const fake={consume:async()=>{throw new Error('must not consume')}}
  assert.equal((await checkAction({action:'deploy',approval:{id:`approval_${'a'.repeat(32)}`,scope:'production'}},{env:{},approvalStore:fake})).reason,'trusted-host-approval-disabled')
  assert.equal((await checkAction({action:'retry_budget_override',approval:{id:`approval_${'a'.repeat(32)}`,scope:'task'}},{env:{HARNESS_ENABLE_TRUSTED_APPROVALS:'true'},approvalStore:fake})).reason,'protected-action-requires-explicit-authorization')
  assert.equal((await checkAction({action:'commit',approval:{id:`approval_${'a'.repeat(32)}`,scope:'release'}},{env:{HARNESS_ENABLE_TRUSTED_APPROVALS:'true'},approvalStore:fake})).reason,'commit-requires-pinned-final-review')
})

test('separate approval-store instances cannot consume one approval concurrently',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'harness-approval-race-')),file=path.join(directory,'approvals.json'),env={HARNESS_ENABLE_TRUSTED_APPROVALS:'true'},issuer=new ApprovalStore({file,env})
  const record=await issuer.issue({action:'deploy',scope:'production:race:abc123',reason:'owner approved exact release'}),first=new ApprovalStore({file,env}),second=new ApprovalStore({file,env})
  const results=await Promise.all([first.consume({id:record.id,action:record.action,scope:record.scope}),second.consume({id:record.id,action:record.action,scope:record.scope})])
  assert.equal(results.filter(result=>result.allowed).length,1);assert.equal(results.filter(result=>result.reason==='trusted-host-approval-already-consumed').length,1)
})

test('an abandoned stale approval lock fails closed instead of being reclaimed unsafely',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'harness-approval-stale-')),file=path.join(directory,'approvals.json'),env={HARNESS_ENABLE_TRUSTED_APPROVALS:'true',HARNESS_APPROVAL_LOCK_TIMEOUT_MS:'30'},store=new ApprovalStore({file,env}),record=await store.issue({action:'deploy',scope:'production:stale:abc123',reason:'owner approved exact release'}),lock=`${file}.lock`
  await mkdir(lock);const old=new Date(Date.now()-60_000);await utimes(lock,old,old)
  try{await assert.rejects(()=>store.consume({id:record.id,action:record.action,scope:record.scope}),/approval-store-lock-timeout/)}finally{await rm(lock,{recursive:true,force:true})}
  const allowed=await store.consume({id:record.id,action:record.action,scope:record.scope});assert.equal(allowed.allowed,true)
})

test('trusted-host CLI preserves a multibyte scope split across stdin chunks',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'harness-approval-utf8-')),file=path.join(directory,'approvals.json'),scope='production:café:abc123',payload=Buffer.from(JSON.stringify({action:'deploy',scope,reason:'owner approved exact release',ttl:60}),'utf8'),split=payload.indexOf(Buffer.from('é'))+1
  const child=spawn(process.execPath,['scripts/approve-action.mjs','--stdin'],{cwd:path.resolve('.'),env:{...process.env,HARNESS_ENABLE_TRUSTED_APPROVALS:'true',HARNESS_APPROVAL_FILE:file},stdio:['pipe','pipe','pipe'],windowsHide:true})
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value)
  child.stdin.write(payload.subarray(0,split));await new Promise(resolve=>setTimeout(resolve,20));child.stdin.end(payload.subarray(split))
  const [code]=await once(child,'exit');assert.equal(code,0,stderr);assert.equal(JSON.parse(stdout).scope,scope)
})

test('create_delegation is provider neutral', () => {
  const result = createDelegationRequest({ role: 'engineer', packet: { task: 'implement' } })
  assert.equal(result.role, 'engineer')
  assert.equal(result.agent.preferredFamily, 'astra')
})

test('review_route always produces reviewer role', async () => {
  const result = await reviewRoute({ task: 'review diff' })
  assert.equal(result.route.role, 'reviewer')
})
