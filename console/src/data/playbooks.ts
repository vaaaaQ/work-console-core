import type { Playbook } from '../model/types.ts'

/* playbooks: ws = owning pack; none = core, offered in every workspace.
   step: m = who does it by default, x = exit criterion, a = artifacts, msg = messages, rv = review, out = variable its accepted draft fills,
   act = the console action its inspector offers ('time' opens the Time view). Step ids are global (message templates key on them), so a new playbook takes new ids */
export const PB0: Record<string, Playbook> ={
 action:{n:'Action',d:'Short task: reply, triage, one-off request',ph:[
  {c:'TR',n:'Triage',s:[{id:'tr',t:'Understand the request',m:'llm',x:'Clear what is being asked'}]},
  {c:'DR',n:'Draft',s:[{id:'dr',t:'Draft the answer',m:'llm',x:'You accepted a draft',a:['draft.md'],out:'draft'}]},
  {c:'SN',n:'Send',s:[{id:'sn',t:'Send it',m:'you',x:'Sent',msg:1}]}]},
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
   {id:'ts2',t:'Send the timesheet',m:'you',x:'The timesheet is sent'}]}]}
};
