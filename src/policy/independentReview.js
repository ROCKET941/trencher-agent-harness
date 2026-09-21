import { safePath } from '../context/evidencePacket.js'
import { digestValue } from '../execution/taskIdentity.js'

const canonical = value => value.replaceAll('\\','/').replace(/^\.\//,'')
export function externalReviewEligibility(packet, context) {
  if(!context?.artifactDigest||!context.commanderAgentId)return{allowed:false,reason:'review-context-required'}
  if(context.implementationProviders?.length!==1||context.implementationProviders[0]!=='openai')return{allowed:false,reason:'external-or-unknown-authorship-native-review'}
  if(context.evidenceComplete!==true)return{allowed:false,reason:'complete-review-evidence-not-attested'}
  const files=context.changedFiles
  if(!Array.isArray(files)||!files.length||files.length>8||files.some(file=>typeof file!=='string'||!safePath(file))||new Set(files.map(canonical)).size!==files.length)return{allowed:false,reason:'invalid-review-file-manifest'}
  if(packet.truncation?.occurred)return{allowed:false,reason:'review-evidence-truncated-or-screened'}
  if(!files.every(file=>packet.excerpts?.some(excerpt=>canonical(excerpt.path)===canonical(file)&&excerpt.content.trim())))return{allowed:false,reason:'review-source-excerpts-missing'}
  return{allowed:true,reason:'bounded-astra-authored-independent-review'}
}

// Server-recorded provider evidence, not a caller-supplied approval. The native
// commander still owns verification and final signoff on exactly this artifact.
export function reviewReceipt(request, report, incomplete) {
  if(request.role!=='reviewer'||!externalReviewEligibility(request.context,request.context?.reviewContext).allowed)return null
  const context=request.context.reviewContext,review=report?.review,files=review?.coveredFiles
  const covered=Array.isArray(files)&&files.length===context.changedFiles.length&&files.every(file=>typeof file==='string')&&new Set(files.map(canonical)).size===files.length&&context.changedFiles.every(file=>files.map(canonical).includes(canonical(file)))
  const validReport=['findings','evidence','tests','blockers'].every(key=>Array.isArray(report?.[key])&&report[key].every(value=>typeof value==='string'))
  const accepted=!incomplete&&validReport&&report?.status==='complete'&&report.artifact==null&&review?.accepted===true&&review.artifactDigest===context.artifactDigest&&covered&&report.blockers.length===0
  return{artifactDigest:context.artifactDigest,contextDigest:digestValue(request.context),accepted,coveredFiles:covered?files:[],readOnly:true}
}
