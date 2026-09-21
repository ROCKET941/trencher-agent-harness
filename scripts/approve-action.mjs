import { ApprovalStore } from '../src/policy/approvalStore.js'
import { isTrustedApprovalAction } from '../src/policy/safety.js'

const readStdin=async()=>{process.stdin.setEncoding('utf8');let value='';for await(const chunk of process.stdin)value+=chunk;return value}
const values=process.argv.length===3&&process.argv[2]==='--stdin'?JSON.parse(await readStdin()):{}
if(process.argv[2]!=='--stdin')for(let index=2;index<process.argv.length;index+=2){const flag=process.argv[index],value=process.argv[index+1];if(!flag?.startsWith('--')||value===undefined)throw new Error(`invalid argument near ${flag||'<end>'}`);values[flag.slice(2)]=value}
if(process.env.HARNESS_ENABLE_TRUSTED_APPROVALS!=='true')throw new Error('trusted host approvals are disabled; set HARNESS_ENABLE_TRUSTED_APPROVALS=true in the server environment')
if(!isTrustedApprovalAction(values.action))throw new Error('action is not eligible for trusted-host approval')
const record=await new ApprovalStore({env:process.env}).issue({action:values.action,scope:values.scope,reason:values.reason,approvedBy:values['approved-by']||'owner',ttlSeconds:values.ttl})
console.log(JSON.stringify({approvalId:record.id,action:record.action,scope:record.scope,approvedBy:record.approvedBy,expiresAt:record.expiresAt,oneTime:true},null,2))
