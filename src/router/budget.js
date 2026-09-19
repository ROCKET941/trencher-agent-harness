export function contextBudget(risk='normal'){return risk==='high'?{files:8,tests:4,docs:2}:{files:6,tests:3,docs:2}}
export function withinBudget(packet,budget=contextBudget(packet.risk)){return packet.files.length<=budget.files&&packet.tests.length<=budget.tests&&packet.docs.length<=budget.docs}
