import test from 'node:test';import assert from 'node:assert/strict';import {classifyRisk} from '../src/router/risk.js';import {deterministicRoute} from '../src/router/deterministic.js';import {nextAttemptState} from '../src/policy/antiLoop.js';import {authorizeAction} from '../src/policy/safety.js';import {planTask} from '../src/orchestrator.js';
test('wallet settlement is high risk',()=>assert.equal(classifyRisk('fix wallet settlement').risk,'high'));
test('search routes scout',()=>assert.equal(deterministicRoute({task:'find callers',risk:'normal'}).role,'scout'));
test('normal routes engineer',()=>assert.equal(deterministicRoute({task:'implement panel',risk:'normal'}).role,'engineer'));
test('unknown high risk routes deep debugger',()=>assert.equal(deterministicRoute({task:'wallet mismatch',risk:'high'}).role,'deep_debugger'));
test('second attempt needs evidence',()=>assert.equal(nextAttemptState({attempts:[{}],newEvidence:false}).allowed,false));
test('third attempt blocked',()=>assert.equal(nextAttemptState({attempts:[{},{}],newEvidence:true}).action,'stop_escalate'));
test('protected action denied',()=>assert.equal(authorizeAction('deploy').allowed,false));
test('orchestrator works without Jev',async()=>{const p=await planTask({task:'Fix localized UI issue',rootCause:'bad prop'},{useJev:false});assert.equal(p.route.role,'engineer')});
