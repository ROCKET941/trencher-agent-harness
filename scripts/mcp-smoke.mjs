import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const expectedTools = [
  'build_evidence_packet',
  'check_action',
  'check_continue',
  'create_delegation',
  'execute_routed_task',
  'review_route',
  'route_task'
]

const child = spawn(process.execPath, ['src/mcp/server.js'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})
const exit = once(child, 'exit')

let stdout = ''
let stderr = ''
const pending = new Map()

const failPending = error => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer)
    reject(error)
  }
  pending.clear()
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  stdout += chunk
  while (stdout.includes('\n')) {
    const newline = stdout.indexOf('\n')
    const line = stdout.slice(0, newline).trim()
    stdout = stdout.slice(newline + 1)
    if (!line) continue

    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (!waiter) continue
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += chunk })
child.on('error', failPending)
child.on('exit', (code, signal) => {
  if (pending.size > 0) {
    failPending(new Error(`MCP server exited before replying (code=${code}, signal=${signal})\n${stderr}`))
  }
})

const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
const request = (id, method, params = {}) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`Timed out waiting for ${method}\n${stderr}`))
  }, 5000)
  pending.set(id, { resolve, reject, timer })
  send({ jsonrpc: '2.0', id, method, params })
})

try {
  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'trencher-mcp-smoke', version: '1.0.0' }
  })
  assert.equal(initialized.serverInfo.name, 'trencher-agent-harness')

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  const listed = await request(2, 'tools/list')
  const toolNames = listed.tools.map(tool => tool.name).sort()
  assert.deepEqual(toolNames, expectedTools)

  console.log(JSON.stringify({
    initialized: initialized.serverInfo,
    protocolVersion: initialized.protocolVersion,
    tools: toolNames
  }, null, 2))
} finally {
  child.stdin.end()
  const timeout = new Promise(resolve => setTimeout(resolve, 1000, 'timeout'))
  if (await Promise.race([exit, timeout]) === 'timeout') child.kill()
}
