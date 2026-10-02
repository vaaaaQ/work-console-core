import type { Playbook, Tpl } from '../model/types.ts'

/* playbooks: ws = owning pack; none = core, offered in every workspace.
   step: m = who does it by default, x = exit criterion, a = artifacts, msg = messages, rv = review, out = variable its accepted draft fills,
   act = the console action its inspector offers ('time' opens the Time view). Step ids are global (message templates key on them), so a new playbook takes new ids */
export const CORE_PB: Record<string, Playbook> ={
 action:{n:'Action',d:'Short task: reply, triage, one-off request',ph:[
  {c:'TR',n:'Triage',s:[{id:'tr',t:'Understand the request',m:'llm',x:'Clear what is being asked'}]},
  {c:'DR',n:'Draft',s:[{id:'dr',t:'Draft the answer',m:'llm',x:'You accepted a draft',a:['draft.md'],out:'draft'}]},
  {c:'SN',n:'Send',s:[{id:'sn',t:'Send it',m:'you',x:'Sent',msg:1}]}]}
};
/* message templates of the core playbooks: [source, channel, text]; {var} fills from the job, the pack or an earlier step */
export const CORE_TPL: Record<string, Tpl[]> = { sn: [['chat', 'reply in the thread', '{draft}']] }

/** the core playbooks plus every registered workspace's; install() fills it */
export const PB0: Record<string, Playbook> = {}
