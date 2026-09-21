import cfg from '../../config/providers.json' with {type:'json'}
import {executionModeForProvider} from '../policy/providerExecution.js'
// Legacy role environment variables cannot weaken the fixed native contract.
// External choices still come from Jev or a capability-validated owner request.
export function resolveRoleTarget(role,_env=process.env){const r=cfg.roles[role];if(!r)throw new Error(`No target for ${role}`);return{...r,configured:true,executionMode:executionModeForProvider(r.provider)}}
