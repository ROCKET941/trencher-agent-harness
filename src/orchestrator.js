import {createEvidencePacket} from './context/evidencePacket.js'
import {classifyRisk} from './router/risk.js'
import {deterministicRoute} from './router/deterministic.js'
import {askJev} from './router/jev.js'
import {nextAttemptState} from './policy/antiLoop.js'
import {createDelegation} from './providers/registry.js'
export async function planTask(input,options={}){const risk=input.risk||classifyRisk(input.task).risk;const packet=createEvidencePacket({...input,risk});const attempt=nextAttemptState({attempts:input.attempts||[],newEvidence:Boolean(input.newEvidence)});if(!attempt.allowed)return{packet,route:{action:attempt.action,reason:attempt.reason},delegation:null};const fallback=deterministicRoute({task:packet.task,risk,rootCause:packet.rootCause,attempts:(input.attempts||[]).length});let route=fallback;if(options.useJev!==false){const jev=await askJev({input:{task:packet.task,risk,rootCauseKnown:Boolean(packet.rootCause),evidenceCount:packet.evidence.length},choices:['scout','engineer','deep_debugger']},options);if(jev.available&&options.normalizeJevDecision){const normalized=options.normalizeJevDecision(jev.decision);if(['scout','engineer','deep_debugger'].includes(normalized?.role))route={role:normalized.role,action:'delegate',reason:'jev'}}}return{packet,route,delegation:route.role?createDelegation(route.role,packet):null}}
