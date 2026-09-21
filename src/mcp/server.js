import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { routeTask, buildEvidencePacket, checkContinue, checkAction, createDelegationRequest, reviewRoute } from './tools.js'
import { executeRoutedTask, resumeRoutedTask, jobStatus, taskUsage, cancelExecution, providerStatus, providerReadiness, modelCatalog } from './tools-v04.js'
import { XAIProvider } from '../providers/xai.js'
import { DeepSeekProvider } from '../providers/deepseek.js'
import { KimiProvider } from '../providers/kimi.js'
import { registerProvider } from '../providers/registry-v12.js'

const out = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const facts = z.array(z.object({ claim: z.string(), source: z.string().optional() })).optional()
const inspected = z.array(z.object({ path: z.string(), range: z.string().optional(), digest: z.string().optional() })).optional()
const workstreams = z.array(z.object({ id:z.string().max(80).optional(), task:z.string().max(1000), rootCause:z.string().max(3000).nullable().optional(), evidence:z.array(z.string().max(3000)).max(5).optional(), files:z.array(z.string().max(500)).max(3).optional(), tests:z.array(z.string().max(500)).max(2).optional(), dependsOn:z.array(z.string().max(500)).max(3).optional() })).max(3).optional()
const routingControls = {
  ownerAuthorizedRetry:z.boolean().optional(), retryReason:z.string().max(500).optional(), routingPhaseId:z.string().max(120).optional(), workstreams,
  requestedRouteAuthorized:z.boolean().optional()
}
const fields = {
  task: z.string().default(''), risk: z.enum(['low', 'normal', 'high']).optional(), evidence: z.array(z.string()).optional(),
  rootCause: z.string().nullable().optional(), files: z.array(z.string()).optional(), tests: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(), protectedBoundaries: z.array(z.string()).optional(), openQuestions: z.array(z.string()).optional(),
  facts, inspected
}

export function createServer(options={}) {
  const env=options.env||process.env,serviceOptions={env,store:options.store,useJev:options.useJev,fetchImpl:options.fetchImpl,planCache:options.planCache,useCache:options.useCache}
  const providers=options.providers||{xai:new XAIProvider({env}),deepseek:new DeepSeekProvider({env}),kimi:new KimiProvider({env})}
  for(const [name,adapter] of Object.entries(providers))registerProvider(name,adapter)
  const server = new McpServer({ name: 'trencher-agent-harness', version: '1.1.2' })
  server.registerTool('route_task', { description: 'Route one meaningful build phase. Jev independently chooses lane/model/effort for the phase and each validated non-overlapping workstream in one request. Use each returned assignment once: external by decisionId, native as a host subagent. Reuse for minor follow-ups.', inputSchema: z.object({ ...fields, ...routingControls, attempts: z.array(z.record(z.string(), z.unknown())).optional(), newEvidence: z.boolean().optional(), useJev: z.boolean().optional(),workspace:z.string().optional(),requestedRoute:z.object({role:z.enum(['scout','engineer','deep_debugger','reviewer','exceptional']).optional(),provider:z.enum(['openai','xai','deepseek','kimi']).optional(),model:z.string().optional(),effort:z.string().optional()}).optional() }) }, async args => out(await routeTask(args, { ...serviceOptions,useJev: options.useJev !== false && args.useJev !== false })))
  server.registerTool('build_evidence_packet', { description: 'Build bounded evidence packet.', inputSchema: z.object(fields) }, async args => out(buildEvidencePacket(args)))
  server.registerTool('check_continue', { description: 'Enforce retry policy. A third and final attempt requires explicit owner authorization, new causal evidence, and a reason.', inputSchema: z.object({ attempts: z.array(z.record(z.string(), z.unknown())).default([]), newEvidence: z.boolean().default(false), ownerAuthorizedRetry:z.boolean().default(false), retryReason:z.string().max(500).optional() }) }, async args => out(checkContinue(args)))
  server.registerTool('check_action', { description: 'Check protected action.', inputSchema: z.object({ action: z.string(), explicitlyAuthorized: z.boolean().default(false) }) }, async args => out(checkAction(args)))
  server.registerTool('create_delegation', { description: 'Create provider-neutral delegation.', inputSchema: z.object({ role: z.enum(['scout', 'engineer', 'deep_debugger', 'reviewer', 'exceptional']), packet: z.object(fields) }) }, async args => out(createDelegationRequest(args)))
  server.registerTool('review_route', { description: 'Create a coherent independent reviewer route, target and delegation. Execute external reviews by returned decisionId; spawn native reviews through the host.', inputSchema: z.object(fields) }, async args => out(await reviewRoute(args,serviceOptions)))
  server.registerTool('execute_routed_task', { description: 'Execute a server-held route using decisionId and optional budget/deadline, without another Jev call. Do not resend task/evidence/target overrides with decisionId. Without decisionId, legacy route-and-execute remains supported. Only xAI/DeepSeek/Kimi use API execution; OpenAI returns a native ChatGPT plan handoff.', inputSchema: z.object({ ...fields, decisionId:z.string().max(80).optional(), ...routingControls, attempts: z.array(z.record(z.string(), z.unknown())).optional(), newEvidence: z.boolean().optional(), workspace:z.string().optional(),taskId:z.string().optional(),idempotencyKey:z.string().optional(),deadlineMs:z.number().int().positive().optional(),commanderMode:z.enum(['host','api']).default('host'),apiCommanderOptIn:z.boolean().optional(),hostCommanderActive:z.boolean().optional(),requestedRoute:z.object({role:z.enum(['scout','engineer','deep_debugger','reviewer','exceptional']).optional(),provider:z.enum(['openai','xai','deepseek','kimi']).optional(),model:z.string().optional(),effort:z.string().optional()}).optional(),executionState:z.record(z.string(),z.unknown()).optional(),budget: z.object({ maxInputTokens: z.number().int().positive().optional(), maxEstimatedInputTokens: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), maxDelegations: z.number().int().positive().optional(), maxParallel: z.number().int().positive().optional(), maxAttempts: z.number().int().positive().optional() }).optional() }) }, async args => out(await executeRoutedTask(args,serviceOptions)))
  server.registerTool('resume_routed_task',{description:'Resume one server-recorded bounded context request with newly approved evidence. The original task, target, accounting, attempts, and budgets remain authoritative.',inputSchema:z.object({jobId:z.string(),approvedEvidence:z.object({evidence:z.array(z.string()).optional(),files:z.array(z.string()).optional(),tests:z.array(z.string()).optional(),docs:z.array(z.string()).optional(),facts,inspected}),deadlineMs:z.number().int().positive().optional(),budget:z.object({maxInputTokens:z.number().int().positive().optional(),maxEstimatedInputTokens:z.number().int().positive().optional(),maxOutputTokens:z.number().int().positive().optional(),maxDelegations:z.number().int().positive().optional()}).optional()})},async args=>out(await resumeRoutedTask(args,serviceOptions)))
  server.registerTool('provider_status',{description:'Inspect provider configuration and optionally validate the account-visible model catalog.',inputSchema:z.object({provider:z.enum(['openai','xai','deepseek','kimi']),refresh:z.boolean().default(false)})},async args=>out(await providerStatus(args,serviceOptions)))
  server.registerTool('provider_readiness',{description:'Check all native and external provider readiness once per build session before routing phases.',inputSchema:z.object({refresh:z.boolean().default(false)})},async args=>out(await providerReadiness(args,serviceOptions)))
  server.registerTool('model_catalog',{description:'List the verified bounded model and effort registry.',inputSchema:z.object({})},async()=>out(modelCatalog()))
  server.registerTool('job_status',{description:'Read server-owned execution job status.',inputSchema:z.object({jobId:z.string()})},async args=>out(await jobStatus(args,serviceOptions)))
  server.registerTool('task_usage',{description:'Read server-owned task and daily accounting.',inputSchema:z.object({taskId:z.string()})},async args=>out(await taskUsage(args,serviceOptions)))
  server.registerTool('cancel_job',{description:'Cancel a running provider job.',inputSchema:z.object({jobId:z.string()})},async args=>out(await cancelExecution(args,serviceOptions)))
  return server
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void serveStdio(createServer)
  console.error('trencher-agent-harness MCP server running on stdio')
}
