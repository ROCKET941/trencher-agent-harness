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
const taskKind=z.enum(['research','mechanical','implementation']).optional()
const excerpts=z.array(z.object({path:z.string().min(1).max(500),range:z.string().max(100).optional(),content:z.string()})).max(8).optional()
const workstreams = z.array(z.object({ id:z.string().max(80).optional(), task:z.string().max(1000), taskKind, rootCause:z.string().max(3000).nullable().optional(), evidence:z.array(z.string().max(3000)).max(5).optional(), excerpts,facts,inspected, files:z.array(z.string().max(500)).max(3).optional(), tests:z.array(z.string().max(500)).max(2).optional(), dependsOn:z.array(z.string().max(500)).max(3).optional() })).max(3).optional()
const digest=z.string().regex(/^[a-f0-9]{64}$/)
const approval=z.object({id:z.string().regex(/^approval_[a-f0-9]{32}$/),scope:z.string().min(1).max(500)}).optional()
const commit=z.object({reviewDecisionId:z.string().max(80),artifactDigest:digest,commander:z.object({agentId:z.string().max(120),provider:z.string(),model:z.string(),effort:z.string(),accepted:z.boolean().optional()}),review:z.object({agentId:z.string().max(120),jobId:z.string().max(120).optional(),provider:z.string(),model:z.string(),effort:z.string(),artifactDigest:digest,fresh:z.boolean(),readOnly:z.boolean(),accepted:z.boolean(),blockers:z.array(z.string()).max(20)}),verification:z.object({artifactDigest:digest,scopeVerified:z.boolean(),checks:z.array(z.object({name:z.enum(['tests','build','typecheck','lint']),status:z.enum(['passed','failed','not_applicable']),evidence:z.string().max(2000),reason:z.string().max(500).optional()})).max(4)})}).optional()
const routingControls = {
  ownerAuthorizedRetry:z.boolean().optional(), retryReason:z.string().max(500).optional(), routingPhaseId:z.string().max(120).optional(), workstreams,
  requestedRouteAuthorized:z.boolean().optional()
}
const fields = {
  task: z.string().default(''), taskKind, risk: z.enum(['low', 'normal', 'high']).optional(), evidence: z.array(z.string()).optional(),
  rootCause: z.string().nullable().optional(), files: z.array(z.string()).optional(), tests: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(), protectedBoundaries: z.array(z.string()).optional(), openQuestions: z.array(z.string()).optional(),
  facts, inspected, excerpts
}

export function createServer(options={}) {
  const env=options.env||process.env,serviceOptions={env,store:options.store,approvalStore:options.approvalStore,useJev:options.useJev,fetchImpl:options.fetchImpl,planCache:options.planCache,useCache:options.useCache}
  const providers=options.providers||{xai:new XAIProvider({env}),deepseek:new DeepSeekProvider({env}),kimi:new KimiProvider({env})}
  for(const [name,adapter] of Object.entries(providers))registerProvider(name,adapter)
  const server = new McpServer({ name: 'trencher-agent-harness', version: '1.3.0' })
  server.registerTool('route_task', { description: 'Route one meaningful build phase for correctness and task fit. Supply bounded source excerpts and facts; paths alone are not source. Jev chooses phase and disjoint workstream targets in one request. Execute each external assignment decisionId once; native Astra commands, integrates and verifies. One independent review and Astra final signoff are required before commit.', inputSchema: z.object({ ...fields, ...routingControls, attempts: z.array(z.record(z.string(), z.unknown())).optional(), newEvidence: z.boolean().optional(), useJev: z.boolean().optional(),workspace:z.string().optional(),requestedRoute:z.object({role:z.enum(['scout','engineer','deep_debugger','reviewer','exceptional']).optional(),provider:z.enum(['openai','xai','deepseek','kimi']).optional(),model:z.string().optional(),effort:z.string().optional()}).optional() }) }, async args => out(await routeTask(args, { ...serviceOptions,useJev: options.useJev !== false && args.useJev !== false })))
  server.registerTool('build_evidence_packet', { description: 'Build bounded evidence packet.', inputSchema: z.object(fields) }, async args => out(buildEvidencePacket(args)))
  server.registerTool('check_continue', { description: 'Enforce retry policy. A third and final attempt requires explicit owner authorization, new causal evidence, and a reason.', inputSchema: z.object({ attempts: z.array(z.record(z.string(), z.unknown())).default([]), newEvidence: z.boolean().default(false), ownerAuthorizedRetry:z.boolean().default(false), retryReason:z.string().max(500).optional() }) }, async args => out(checkContinue(args)))
  server.registerTool('check_action', { description: 'Check protected actions. MCP-supplied authorization flags remain untrusted. Non-commit protected actions require a one-time action-and-scope-bound approval minted by the trusted-host approve:action CLI. Commit uses the pinned Astra final-acceptance gate.', inputSchema: z.object({ action: z.string(), explicitlyAuthorized: z.boolean().default(false), approval, commit }) }, async args => out(await checkAction(args,serviceOptions)))
  server.registerTool('create_delegation', { description: 'Create provider-neutral delegation.', inputSchema: z.object({ role: z.enum(['scout', 'engineer', 'deep_debugger', 'reviewer', 'exceptional']), packet: z.object(fields) }) }, async args => out(createDelegationRequest(args)))
  server.registerTool('review_route', { description: 'Pin one independent read-only reviewer. Complete Astra-authored artifacts with source/diff excerpts may use Jev-selected Kimi/Grok/DeepSeek; legacy, incomplete or external-authored packets use fresh native Astra. Supply exact artifact and changed-file manifest. External acceptance requires an actual completed server job; Astra retains final signoff.', inputSchema: z.object({...fields,reviewMode:z.enum(['auto','native']).optional(),reviewContext:z.object({artifactDigest:digest,commanderAgentId:z.string().min(1).max(120),implementationProviders:z.array(z.enum(['openai','xai','deepseek','kimi'])).max(4).optional(),changedFiles:z.array(z.string().min(1).max(500)).max(64).optional(),evidenceComplete:z.boolean().optional()}).optional()}) }, async args => out(await reviewRoute(args,serviceOptions)))
  server.registerTool('execute_routed_task', { description: 'Execute a server-held route using decisionId and optional budget/deadline, without another Jev call. Do not resend task/evidence/target overrides with decisionId. Without decisionId, legacy route-and-execute remains supported. Only xAI/DeepSeek/Kimi use API execution; OpenAI returns a native ChatGPT plan handoff.', inputSchema: z.object({ ...fields, decisionId:z.string().max(80).optional(), ...routingControls, attempts: z.array(z.record(z.string(), z.unknown())).optional(), newEvidence: z.boolean().optional(), workspace:z.string().optional(),taskId:z.string().optional(),idempotencyKey:z.string().optional(),deadlineMs:z.number().int().positive().optional(),commanderMode:z.enum(['host','api']).default('host'),apiCommanderOptIn:z.boolean().optional(),hostCommanderActive:z.boolean().optional(),requestedRoute:z.object({role:z.enum(['scout','engineer','deep_debugger','reviewer','exceptional']).optional(),provider:z.enum(['openai','xai','deepseek','kimi']).optional(),model:z.string().optional(),effort:z.string().optional()}).optional(),executionState:z.record(z.string(),z.unknown()).optional(),budget: z.object({ maxInputTokens: z.number().int().positive().optional(), maxEstimatedInputTokens: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), maxDelegations: z.number().int().positive().optional(), maxParallel: z.number().int().positive().optional(), maxAttempts: z.number().int().positive().optional() }).optional() }) }, async args => out(await executeRoutedTask(args,serviceOptions)))
  server.registerTool('resume_routed_task',{description:'Resume one server-recorded bounded coding context request with newly approved evidence. The original task, target, accounting, attempts, and budgets remain authoritative. Reviews with missing evidence require a newly prepared review route.',inputSchema:z.object({jobId:z.string(),approvedEvidence:z.object({evidence:z.array(z.string()).optional(),files:z.array(z.string()).optional(),tests:z.array(z.string()).optional(),docs:z.array(z.string()).optional(),facts,inspected,excerpts}),deadlineMs:z.number().int().positive().optional(),budget:z.object({maxInputTokens:z.number().int().positive().optional(),maxEstimatedInputTokens:z.number().int().positive().optional(),maxOutputTokens:z.number().int().positive().optional(),maxDelegations:z.number().int().positive().optional()}).optional()})},async args=>out(await resumeRoutedTask(args,serviceOptions)))
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
