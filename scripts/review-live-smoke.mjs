import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createServer } from '../src/mcp/server.js'

// Opt-in: two tiny live Jev/provider reviews through MCP. Never edits application
// code or commits/deploys. Shared server accounting and all paid gates still apply.
assert.equal(process.env.HARNESS_ENABLE_LIVE_REVIEW_SMOKE,'true','Set HARNESS_ENABLE_LIVE_REVIEW_SMOKE=true to allow the paid smoke test')
const server=createServer(),[client,transport]=InMemoryTransport.createLinkedPair()
let sequence=0
const pending=new Map()
client.onmessage=message=>{if(message.id!=null){pending.get(message.id)?.(message);pending.delete(message.id)}}
await server.connect(transport);await client.start()
const rpc=(method,params)=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('smoke-rpc-timeout'))},60000)
  pending.set(id,message=>{clearTimeout(timer);message.error?reject(new Error(message.error.message)):resolve(message.result)})
  void client.send({jsonrpc:'2.0',id,method,params}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error)})
})
const call=async(name,args)=>{const result=await rpc('tools/call',{name,arguments:args});assert.ok(!result.isError,`${name} failed`);return JSON.parse(result.content[0].text)}
try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'cross-review-live-smoke',version:'1'}})
  await client.send({jsonrpc:'2.0',method:'notifications/initialized'})
  for(const defective of process.argv.includes('--corrected-only')?[false]:[true,false]){
    const source=`export const clamp=(x,lo,hi)=>Math.min(${defective?'lo':'hi'},Math.max(lo,x))`
    const artifactDigest=createHash('sha256').update(source).digest('hex'),started=Date.now()
    const plan=await call('review_route',{
      task:`Independent clamp review smoke v1.3 ${defective?'candidate A':'candidate B'}. For finite numbers with lo<=hi, return x clamped inclusively to [lo,hi]. Inspect the entire supplied source against that requirement. Do not assume author correctness.`,
      files:['src/clamp.js'],excerpts:[{path:'src/clamp.js',range:'1',content:source}],
      evidence:['Harness acceptance requires an actual report_result function call with all required array fields and review coverage; an otherwise correct analysis without that contract is incomplete.'],
      tests:['Required cases: clamp(5,0,10)=5; clamp(-1,0,10)=0; clamp(11,0,10)=10.'],
      reviewContext:{artifactDigest,commanderAgentId:'live-smoke-commander',implementationProviders:['openai'],changedFiles:['src/clamp.js'],evidenceComplete:true}
    })
    if(plan.route.executionMode!=='external_api')console.log(JSON.stringify({sample:defective?'known-defect':'corrected',selection:plan.routingDecision.selection.target,advice:plan.advice?.answers}))
    assert.equal(plan.route.executionMode,'external_api',`No external review selected: ${plan.route.modelSelectionReason}`)
    const routedMs=Date.now()-started,run=await call('execute_routed_task',{decisionId:plan.routingDecision.decisionId})
    const job=run.execution?.job
    console.log(JSON.stringify({sample:defective?'known-defect':'corrected',jevModel:plan.advice?.model,target:plan.routingDecision.effective,selection:plan.routingDecision.selection.target,decisionId:plan.routingDecision.decisionId,jobId:job?.id,executed:run.execution?.executed,reason:run.execution?.reason,review:job?.review,report:run.execution?.result?.structured,usage:job?.usage,costUsd:job?.actualCostUsd,routingMs:routedMs,totalMs:Date.now()-started}))
    if(job?.review?.accepted!==!defective)console.log(JSON.stringify({finishReason:run.execution?.result?.finishReason,completion:run.execution?.result?.completion,toolCalls:run.execution?.result?.metadata?.toolCalls}))
    assert.equal(run.execution?.executed,true,'Provider did not execute; inspect bounded reason and do not silently retry')
    assert.equal(job?.review?.accepted,!defective,'Reviewer verdict must distinguish the known defect from the corrected implementation')
  }
}finally{await client.close();await server.close()}
