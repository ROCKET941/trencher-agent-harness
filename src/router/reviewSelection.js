import { askJev, routingModels, normalizeChoice } from './jev.js'
import { FINAL_REVIEWER } from '../policy/quality.js'
import { externalReviewEligibility } from '../policy/independentReview.js'

export async function chooseReviewTarget(packet, input, options) {
  const env=options.env||process.env
  const native={role:'reviewer',...FINAL_REVIEWER,configured:true}
  const eligibility=externalReviewEligibility(packet,packet.reviewContext)
  const models=routingModels(env,'reviewer').filter(model=>model.executionMode==='external_api')
  let reason=input.reviewMode==='native'?'host-requested-native-review':eligibility.reason,advice=null,effective=native
  // Relative ranking confidence is not the probability that a review is correct.
  // Eligibility admits only capable, read-only challengers with complete evidence;
  // exact-artifact receipts, host checks and Astra signoff still gate acceptance.
  const configuredThreshold=Number(env.JEV_REVIEW_MIN_CONFIDENCE??0)
  const threshold=Number.isFinite(configuredThreshold)&&configuredThreshold>=0&&configuredThreshold<=1?configuredThreshold:1
  if(input.reviewMode!=='native'&&eligibility.allowed&&models.length&&options.useJev!==false){
    const raw=await askJev({state:packet,questions:{
      reviewer:{type:'choice',instructions:'Choose the most capable independent reviewer of this Astra-authored artifact. Judge correctness, task fit and supplied evidence first, then latency, cost last. No invented benchmark history. This is read-only code analysis: no tools, edits, tests or release authority. Identify concrete defects and missing evidence; do not endorse the author narrative.',criteria:Object.fromEntries(models.map(model=>[`${model.provider}:${model.id}`,`${model.id}: independent code, regression and test-coverage challenge using supplied source/diff excerpts.`]))},
      effort:{type:'choice',instructions:'Choose sufficient depth for an independent correctness review. High risk needs at least high.',criteria:{high:'Careful bounded correctness review.',max:'Exceptional reasoning depth for interacting invariants.'}}
    }},{...options,taskContext:{task:packet.task,rootCause:packet.rootCause}})
    const choice=normalizeChoice(raw.answers?.reviewer),effort=normalizeChoice(raw.answers?.effort)
    advice={...raw,reviewer:choice,effort}
    const model=models.find(model=>`${model.provider}:${model.id}`===choice?.choice)
    const validConfidence=Number.isFinite(raw.answers?.reviewer?.confidence)&&choice?.confidence>=0&&choice.confidence<=1
    if(raw.available&&model&&validConfidence&&choice.confidence>=threshold){
      const depth=effort?.choice==='max'&&effort.confidence>=.7&&effort.confidence<=1?model.efforts.at(-1):'high'
      effective={role:'reviewer',provider:model.provider,model:model.id,effort:depth,configured:true,executionMode:'external_api'}
      reason='jev-independent-cross-model-review'
    }else reason=raw.available?'review-choice-unqualified-native-fallback':raw.reason
  }else if(eligibility.allowed&&!models.length)reason='external-review-provider-unavailable'
  else if(eligibility.allowed&&options.useJev===false)reason='jev-disabled-native-review'
  return{effective,recommended:effective,advice,trace:{source:effective.executionMode==='external_api'?'jev':'deterministic-review-policy',reason,threshold,confidenceMeaning:'relative-model-preference-not-review-accuracy',eligibility,jev:advice?.reviewer||null,fallback:native,requested:input.requestedRoute?{value:input.requestedRoute,accepted:false,reason:input.requestedRoute.role&&input.requestedRoute.role!=='reviewer'?'deterministic-role-floor':'review-selection-policy'}:null}}
}
