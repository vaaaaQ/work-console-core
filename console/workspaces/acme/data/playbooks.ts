import type { Playbook, Tpl } from '../../../src/model/types.ts'

/* Acme's built-in playbooks; the core's (action) are offered beside them. Step ids are global, so these take their own */
export const playbooks: Record<string, Playbook> ={
 'dev-item':{ws:'acme',n:'Dev item',d:'Issue from analysis to QA hand-off',ph:[
  {c:'AN',n:'Analysis',s:[
   {id:'an1',t:'Read the issue',m:'llm',x:'Acceptance criteria are clear',a:['analysis.md']},
   {id:'an2',t:'Read the linked docs',m:'llm',x:'Relevant pages summarised',a:['notes.md']},
   {id:'an3',t:'Questions to the PO',m:'you',x:'Answered or dropped',msg:1}]},
  {c:'TD',n:'Tech design',s:[
   {id:'td1',t:'Technical design',m:'llm',x:'design.md agreed',a:['design.md']},
   {id:'td2',t:'Check contradictions',m:'llm',x:'No open contradictions'}]},
  {c:'IM',n:'Build',s:[
   {id:'im1',t:'Branch from main',m:'you',x:'Branch exists',a:['branch']},
   {id:'im2',t:'Code and unit tests',m:'llm',x:'Tests green',a:['diff','tests']},
   {id:'im3',t:'Run it locally',m:'you',x:'The scenario passes locally',a:['run.log']}]},
  {c:'PR',n:'Pull request',s:[
   {id:'pr1',t:'Open the PR',m:'you',x:'PR open, reviewers set',a:['PR']},
   {id:'pr2',t:'Ask for review',m:'you',x:'Post sent',msg:1},
   {id:'pr3',t:'Review: 2 approvals',m:'you',x:'Two approvals, no changes requested',rv:1},
   {id:'pr4',t:'Merge',m:'you',x:'Merged into main',a:['merge']}]},
  {c:'QA',n:'QA and close',s:[
   {id:'qa1',t:'Deploy to staging',m:'you',x:'The build is on staging',a:['build']},
   {id:'qa2',t:'Hand over to QA',m:'you',x:'QA confirmed',msg:2},
   {id:'qa3',t:'Close the issue',m:'you',x:'Issue closed',msg:1}]}]},
 'ci-failure':{ws:'acme',ks:'ci',n:'CI failure',d:'A red build from triage to green',ph:[
  {c:'TR',n:'Triage',s:[
   {id:'cf1',t:'Read the failed build',m:'llm',x:'Failing stage and first error known',a:['triage.md']},
   {id:'cf2',t:'Flaky or real?',m:'llm',x:'Decided: rerun or fix',out:'cause'}]},
  {c:'FX',n:'Fix',s:[
   {id:'cf3',t:'Fix or rerun',m:'you',x:'The build is green',a:['build']}]},
  {c:'RP',n:'Report',s:[
   {id:'cf4',t:'Tell the channel',m:'you',x:'Post sent',msg:1}]}]},
 'acme-timesheet':{ws:'acme',ks:'time',n:'Timesheet',d:'Month end: fill the hours, then send the timesheet',ph:[
  {c:'TM',n:'Time',s:[
   {id:'ts1',t:'Fill the month',m:'you',x:'Every day you worked has hours',act:'time'}]},
  {c:'SN',n:'Send',s:[
   {id:'ts2',t:'Send the timesheet',m:'you',x:'The timesheet is sent'}]}]},
 // the one-time approval and fix rounds: accepting Analysis approves these commands for the job, and a failed live
 // check goes back to Build by itself, at most 3 times in a row
 'auto-ship':{ws:'acme',n:'Auto ship',d:'Analysis by hand, then build, ship and check by themselves',
  ok:{at:'as1',cmds:['git status','git log --oneline -1 {branch}','echo ship {branch} onto {base}']},ph:[
  {c:'AN',n:'Analysis',s:[
   {id:'as1',t:'Analysis',m:'llm',x:'The change is clear',a:['spec.md']}]},
  {c:'BD',n:'Build',s:[
   {id:'as2',t:'Build',m:'llm',x:'Tests green, committed on the branch',start:'auto'}]},
  {c:'SH',n:'Ship',s:[
   {id:'as3',t:'Ship',m:'llm',x:'The commands ran',start:'auto'},
   {id:'as4',t:'Live check',m:'llm',x:'https://status.acme.example answers ok',start:'auto',retry:{to:'as2'}}]},
  {c:'CL',n:'Close',s:[
   {id:'as5',t:'Look at it live',m:'you',x:'It works'}]}]}
};

/* message templates: [source, channel, text]; {var} fills from the job, the pack or an earlier step */
export const templates: Record<string, Tpl[]> ={
 an3:[['chat','PO','hi {po},\none question on {key} before design: should the limit count per token or per user?']],
 pr2:[['chat','#team-dev','hi all,\nPR {pr} ({key}, rate limiting per token) is ready for review.']],
 qa2:[['chat','#qa','hi team,\n{key} is on staging (build {build}): rate limiting per token.'],['work','comment on the issue','Deployed to staging in build {build}; ready for QA.']],
 qa3:[['work','comment on the issue','Verified by QA in build {build}; closing.']],
 cf4:[['chat','#team-dev','hi all,\n{key} is green again. Cause: {cause}']]
};
