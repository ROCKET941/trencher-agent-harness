import {
  routeTask, checkContinue, checkAction, reviewRoute
} from '../src/mcp/tools.js'

const out = {
  route: (await routeTask({ task: 'Fix a localized UI rendering bug', rootCause: 'stale memo' }, { useJev: false })).route,
  antiLoop: checkContinue({ attempts: [{}], newEvidence: false }),
  protectedAction: checkAction({ action: 'deploy' }),
  review: (await reviewRoute({ task: 'Review localized UI fix' })).route
}
console.log(JSON.stringify(out, null, 2))
