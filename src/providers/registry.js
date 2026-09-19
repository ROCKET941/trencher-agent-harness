import agents from '../../config/agents.json' with {type:'json'}
export function getRole(role){const config=agents.roles[role];if(!config)throw new Error(`Unknown agent role: ${role}`);return structuredClone(config)}
export function createDelegation(role,packet){return{role,agent:getRole(role),context:packet,instruction:'Return only findings/results needed by the parent orchestrator. Do not expand scope.'}}
