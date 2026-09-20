import cfg from '../../config/providers.json' with {type:'json'}
import {executionModeForProvider} from '../policy/providerExecution.js'
const roleEnv={scout:'SCOUT',engineer:'ENGINEER',deep_debugger:'DEBUG',reviewer:'REVIEW',exceptional:'EXCEPTIONAL'}
export function resolveRoleTarget(role,env=process.env){const r=cfg.roles[role];if(!r)throw new Error(`No target for ${role}`);const prefix=`HARNESS_${roleEnv[role]}`,provider=env[`${prefix}_PROVIDER`]||r.provider,model=env[`${prefix}_MODEL`]||r.model,effort=env[`${prefix}_EFFORT`]||r.effort;return{provider,model,effort,configured:Boolean(model),executionMode:executionModeForProvider(provider)}}
