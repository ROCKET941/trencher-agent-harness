import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import {
  routeTask, buildEvidencePacket, checkContinue, checkAction,
  createDelegationRequest, reviewRoute
} from './tools.js'

const textResult = value => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
})

const packetFields = {
  task: z.string().default(''),
  risk: z.enum(['low','normal','high']).optional(),
  evidence: z.array(z.string()).optional(),
  rootCause: z.string().nullable().optional(),
  files: z.array(z.string()).optional(),
  tests: z.array(z.string()).optional(),
  docs: z.array(z.string()).optional(),
  protectedBoundaries: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional()
}

export function createServer() {
  const server = new McpServer({
    name: 'trencher-agent-harness',
    version: '0.2.0'
  })

  server.registerTool('route_task', {
    description: 'Classify and route an engineering task to the cheapest capable logical agent role.',
    inputSchema: z.object({
      ...packetFields,
      attempts: z.array(z.record(z.string(), z.unknown())).optional(),
      newEvidence: z.boolean().optional(),
      useJev: z.boolean().optional()
    })
  }, async args => textResult(await routeTask(args, { useJev: args.useJev !== false })))

  server.registerTool('build_evidence_packet', {
    description: 'Create a bounded evidence packet and compact task ledger for delegation.',
    inputSchema: z.object(packetFields)
  }, async args => textResult(buildEvidencePacket(args)))

  server.registerTool('check_continue', {
    description: 'Enforce the two-strike anti-loop rule before another implementation attempt.',
    inputSchema: z.object({
      attempts: z.array(z.record(z.string(), z.unknown())).default([]),
      newEvidence: z.boolean().default(false)
    })
  }, async args => textResult(checkContinue(args)))

  server.registerTool('check_action', {
    description: 'Check deterministic authorization for a potentially protected action.',
    inputSchema: z.object({
      action: z.string(),
      explicitlyAuthorized: z.boolean().default(false)
    })
  }, async args => textResult(checkAction(args)))

  server.registerTool('create_delegation', {
    description: 'Create a bounded provider-neutral delegation request for a logical agent role.',
    inputSchema: z.object({
      role: z.enum(['scout','engineer','deep_debugger','reviewer','exceptional']),
      packet: z.object(packetFields)
    })
  }, async args => textResult(createDelegationRequest(args)))

  server.registerTool('review_route', {
    description: 'Create a fresh bounded independent-review delegation after implementation.',
    inputSchema: z.object(packetFields)
  }, async args => textResult(await reviewRoute(args)))

  return server
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void serveStdio(createServer)
  console.error('trencher-agent-harness MCP server running on stdio')
}
