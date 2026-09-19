const HIGH=['wallet','swap','settlement','transaction','execution','accounting','pnl','keeper','authentication','security','redis','concurrency','race','runtime role','deployment','production source','real funds']
export function classifyRisk(task=''){const text=task.toLowerCase();const matches=HIGH.filter(term=>text.includes(term));return{risk:matches.length?'high':'normal',matches}}
