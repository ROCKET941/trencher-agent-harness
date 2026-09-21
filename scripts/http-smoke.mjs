import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url)),port=20000+(process.pid%10000),token='offline-smoke-token'
const child=spawn(process.execPath,['src/mcp/http-server.js'],{cwd:root,env:{...process.env,HARNESS_HOST:'127.0.0.1',HARNESS_PORT:String(port),HARNESS_MCP_TOKEN:token},stdio:['ignore','pipe','pipe'],windowsHide:true}),exit=once(child,'exit')
let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk})
const waitReady=async()=>{for(let i=0;i<50;i++){try{const result=await fetch(`http://127.0.0.1:${port}/health`);if(result.ok)return}catch{}await new Promise(resolve=>setTimeout(resolve,50))}throw new Error(`HTTP server did not start\n${stderr}`)}
const rpc=async(body,session)=>{const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session}:{})},body:JSON.stringify(body)});const text=await response.text();assert.ok([200,202].includes(response.status),text);const sessionId=response.headers.get('mcp-session-id')||session,data=response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').find(line=>line.startsWith('data: '))?.slice(6):text;return{value:data?JSON.parse(data):null,sessionId}}
try{
  await waitReady()
  const unauthorized=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401)
  const initialized=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'http-smoke',version:'1'}}})
  assert.equal(initialized.value.result.serverInfo.name,'trencher-agent-harness')
  await rpc({jsonrpc:'2.0',method:'notifications/initialized',params:{}},initialized.sessionId)
  const listed=await rpc({jsonrpc:'2.0',id:2,method:'tools/list',params:{}},initialized.sessionId);assert.ok(listed.value.result.tools.some(tool=>tool.name==='model_catalog'))
  const called=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'model_catalog',arguments:{}}},initialized.sessionId),catalog=JSON.parse(called.value.result.content[0].text);assert.equal(catalog.models.length,8)
  const routed=await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'route_task',arguments:{task:'HTTP smoke caller lookup',useJev:false}}},initialized.sessionId),plan=JSON.parse(routed.value.result.content[0].text)
  const executed=await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'execute_routed_task',arguments:{decisionId:plan.routingDecision.decisionId}}},initialized.sessionId),execution=JSON.parse(executed.value.result.content[0].text)
  assert.equal(execution.reason,'native-host-agent-required');assert.equal(execution.plan.routingDecision.decisionId,plan.routingDecision.decisionId)
  console.log(JSON.stringify({transport:'streamable-http',initialized:true,tools:listed.value.result.tools.length,catalogModels:catalog.models.length,pinnedDecisionReused:true},null,2))
}finally{child.kill();await Promise.race([exit,new Promise(resolve=>setTimeout(resolve,1000))])}
