import {planTask} from '../src/orchestrator.js'
for(const example of [{task:'Find every caller of reconcileSwapFill'},{task:'Fix a localized UI rendering bug',rootCause:'stale memo dependency'},{task:'Diagnose wallet settlement mismatch after a swap'}]){const plan=await planTask(example,{useJev:false});console.log(JSON.stringify({task:example.task,route:plan.route},null,2))}
