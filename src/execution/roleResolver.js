import cfg from '../../config/providers.json' with {type:'json'}
export function resolveRoleTarget(role,env=process.env){const r=cfg.roles[role];if(!r)throw new Error(`No target for ${role}`);const model=env[r.modelEnv]||'';return{provider:r.provider,model,configured:Boolean(model)}}
