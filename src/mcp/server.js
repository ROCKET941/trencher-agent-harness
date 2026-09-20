import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { routeTask, buildEvidencePacket, checkContinue, checkAction, createDelegationRequest, reviewRoute } from './tools.js'
import { executeRoutedTask } from './tools-v04.js'
import { OpenAIProvider } from '../providers/openai.js'
import { registerProvider } from '../providers/registry-v12.js'

const out = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const facts = z.array(z.object({ claim: z.string(), source: z.string().optional() })).optional()
const inspected = z.array(z.object({ path: z.string(), range: z.string().optional(), digest: z.string().optional() })).optional()
const fields = {
  task: z.string().default(''), risk: z.enum(['low', 'normal', 'high']).optional(), evidence: z.array(z.string()).optional(),
  rootCause: z.string().nullable().optional(), files: z.array(z.string()).optional(), tests: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(), protectedBoundaries: z.array(z.string()).optional(), openQuestions: z.array(z.string()).optional(),
  facts, inspected
}

export function createServer() {
  registerProvider('openai', new OpenAIProvider())
  const server = new McpServer({ name: 'trencher-agent-harness', version: '0.4.0' })
  server.registerTool('route_task', { description: 'Route to cheapest capable role.', inputSchema: z.object({ ...fields, attempts: z.array(z.record(z.string(), z.unknown())).optional(), newEvidence: z.boolean().optional(), useJev: z.boolean().optional() }) }, async args => out(await routeTask(args, { useJev: args.useJev !== false })))
  server.registerTool('build_evidence_packet', { description: 'Build bounded evidence packet.', inputSchema: z.object(fields) }, async args => out(buildEvidencePacket(args)))
  server.registerTool('check_continue', { description: 'Enforce two-strike rule.', inputSchema: z.object({ attempts: z.array(z.record(z.string(), z.unknown())).default([]), newEvidence: z.boolean().default(false) }) }, async args => out(checkContinue(args)))
  server.registerTool('check_action', { description: 'Check protected action.', inputSchema: z.object({ action: z.string(), explicitlyAuthorized: z.boolean().default(false) }) }, async args => out(checkAction(args)))
  server.registerTool('create_delegation', { description: 'Create provider-neutral delegation.', inputSchema: z.object({ role: z.enum(['scout', 'engineer', 'deep_debugger', 'reviewer', 'exceptional']), packet: z.object(fields) }) }, async args => out(createDelegationRequest(args)))
  server.registerTool('review_route', { description: 'Create independent review delegation.', inputSchema: z.object(fields) }, async args => out(await reviewRoute(args)))
  server.registerTool('execute_routed_task', { description: 'Route and execute one bounded task through the configured provider. Hard budgets apply.', inputSchema: z.object({ ...fields, attempts: z.array(z.record(z.string(), z.unknown())).optional(), newEvidence: z.boolean().optional(), budget: z.object({ maxInputTokens: z.number().int().positive().optional(), maxEstimatedInputTokens: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(), maxDelegations: z.number().int().positive().optional(), maxParallel: z.number().int().positive().optional(), maxAttempts: z.number().int().positive().optional() }).optional() }) }, async args => out(await executeRoutedTask(args)))
  return server
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void serveStdio(createServer)
  console.error('trencher-agent-harness MCP server running on stdio')
}
