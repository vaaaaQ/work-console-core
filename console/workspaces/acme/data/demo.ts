import type { Chat, JobSeed, JournalEntry, LogEntry, Mail, Pr, StepOverride } from '../../../src/model/types.ts'
import type { WorkDoc } from '../../../src/data/demo.ts'
import type { GatewayItem } from '../../../src/workspace.ts'
import { weekDays } from '../../../src/model/cal.ts'
import { dayOf, fromWall } from '../../../src/lib/zone.ts'

/* the demo workplace, Acme (fictional): jobs, chats, mail and meetings. at = current step, upd = minutes ago */
export const jobs: JobSeed[] =[
 {id:'J-0412',ws:'acme',key:'ACME-512',pb:'dev-item',prj:'platform',t:'Public API: rate limiting per token',st:'review',at:'pr3',upd:38,slug:'20260924-acme-512-rate-limit'},
 {id:'J-0409',ws:'acme',key:'BUILD-1287',pb:'ci-failure',prj:'ops',t:'main #1287: integration tests failed',st:'active',at:'cf3',upd:4,slug:'20260926-main-1287',ctx:[]},
 {id:'J-0420',ws:'acme',key:'CHAT',pb:'action',prj:'platform',t:'Reply to Sam about rate limiting',st:'waiting-user',at:'sn',upd:26,slug:'action-5e1f09c2a7d4b318',chat:'c4'},
 {id:'J-0418',ws:'acme',key:'ACME-530',pb:'dev-item',prj:'platform',t:'Search: index archived projects',st:'waiting-external',at:'qa1',upd:190,slug:'20260921-acme-530-search-archived'},
 {id:'J-0419',ws:'acme',key:'SUP-77',pb:'action',prj:'ops',t:'Support ticket: the weekly report is not generated',st:'ready',at:'tr',upd:55,slug:'action-8a04c1d9e2f37b65',ctx:[]},
 {id:'J-0301',ws:'acme',key:'WEEKLY',pb:'action',prj:'ops',t:'Weekly status update',st:'recurring',at:'dr',upd:300,slug:'action-3c9e0b7f41d2a865'},
 {id:'J-0398',ws:'acme',key:'ACME-480',pb:'dev-item',prj:'web',t:'Login: remember the last workspace',st:'done',at:null,upd:2880,slug:'20260915-acme-480-last-workspace'},
 {id:'J-0402',ws:'acme',key:'ACME-455',pb:'dev-item',prj:'web',t:'Notifications: daily digest',st:'cancelled',at:'im2',upd:4320,slug:'20260912-acme-455-digest'}
];

/** a past round per demo job: the job went back to `to` for `why`; that round had got as far as `upTo` */
export const ret: Record<string, { to: string; upTo: string; at: string; why: string; by: string }> = {
  'J-0418': { to: 'im2', upTo: 'qa2', at: '2026-09-25T14:20:00Z', why: 'QA found that search misses projects archived today', by: 'Claude Code' },
}

/* per-step overrides: s state, m meta, arts, b badges {k,t,r,o(open)}, rv review, dr pending LLM draft, out accepted output */
export const ovr: Record<string, Record<string, StepOverride>> ={
 'J-0412':{
  an1:{m:'6 min'},an2:{m:'3 pages read'},
  an3:{m:'sent, answered',b:[{k:'q',t:'Should the limit count per token or per user?',r:'PO: per token.'}]},
  td1:{b:[{k:'d',t:'The gateway already has a token bucket',r:'Reuse it; no new limiter.'}]},
  td2:{b:[{k:'c',t:'The issue says “warn”; the API docs say “reject with 429”',r:'Agreed with the PO: reject with 429, as documented.'}]},
  im1:{arts:[{n:'feature/ACME-512-rate-limit',ok:true}]},
  im2:{arts:[{n:'diff +214 −37',ok:true},{n:'tests 14/14',ok:true}]},
  im3:{b:[{k:'p',t:'Port clash with an old test database',r:'Stopped the old container; the rerun passed.'}]},
  pr1:{arts:[{n:'PR #482',ok:true}]},
  pr2:{m:'sent 09:12'},
  pr3:{m:'approvals 1/2',rv:{v:[{n:'Priya Shah',v:1},{n:'Tom Becker',v:0}],need:2}}
 },
 'J-0409':{cf3:{s:'bad',m:'failed again after a rerun',b:[{k:'p',o:1,t:'Integration tests time out on agent-3',r:''}]}},
 'J-0418':{qa1:{m:'staging deploy queued'}},
 'J-0420':{tr:{m:'from the chat with Sam Rivera'},dr:{m:'accepted with one edit',out:'hi Sam,\nrate limiting is in review (PR #482), one approval left. I will write here once it is on staging.'}},
 'J-0301':{tr:{m:'from the week’s issues and builds'},dr:{s:'wait',m:'LLM draft ready',dr:{t:'This week:\n• ACME-512 rate limiting: in review, one approval left\n• ACME-530 search: waiting for staging\n• main went red on #1287 and is being fixed',at:'2026-09-29T13:48:00Z'}}}
};

/* journals: ## <ts> — <actor> / Observed / Changed / Next. Actors: you, LLM (a run you asked for) */
export const jr: Record<string, JournalEntry[]> ={
 'J-0412':[
  {ts:'2026-09-29T13:05:40Z',a:'you',o:'PR #482: Priya Shah approved; Tom Becker has not reviewed.',c:'approvals 1/2; the review step waits.',n:'nudge #team-dev tomorrow if there is still no second approval.'},
  {ts:'2026-09-29T12:12:03Z',a:'you',o:'PR #482 opened, reviewers set.',c:'posted in #team-dev after you confirmed the text.',n:'wait for 2 approvals.'},
  {ts:'2026-09-28T20:40:11Z',a:'you',o:'Local run: port clash with an old test database.',c:'the rerun passed; run.log attached.',n:'open the PR.'}],
 'J-0409':[{ts:'2026-09-29T14:48:02Z',a:'you',o:'Rerun of main #1287: integration tests timed out again on agent-3.',c:'step marked as a problem; build log attached.',n:'pin another agent, or dig into the test setup.'}]
};

export const pri: Record<string, Pr> ={'J-0412':{id:'#482',br:'feature/ACME-512-rate-limit',to:'main',ch:'#team-dev'}};
/* canned LLM answers for the demo; anything else gets a generic draft */
export const llms: Record<string, string> ={
 'J-0409/cf3':'Rerun once on another agent: agent-3 shares its test database port with the nightly job. If it fails again, compare the first failing test with the last green build.',
 'J-0419/tr':'The weekly report stopped after the last release: its export query now hits the 30 s timeout. Ask the data team whether the timeout changed, and attach the job log to the ticket.',
};

export const chats: Chat[] =[
  {id:'c1',name:'#team-dev',kind:'channel',unread:2,sum:'PR #482 needs a second approval. Priya approved with a nit on a name; Tom will look after lunch.',msgs:[
   {who:'Priya Shah',at:'08:47',t:'Left one nit on the limiter name, otherwise approved.'},
   {who:'You',me:1,at:'09:12',t:'hi all,\nPR #482 (ACME-512, rate limiting per token) is ready for review.'},
   {who:'Tom Becker',at:'10:05',t:'Will look after lunch.'}]},
  {id:'c2',name:'Daily stand-up',kind:'meeting chat',unread:0,sum:'The 09:30 stand-up is over; your update on ACME-512 was given.',msgs:[
   {who:'You',me:1,at:'09:33',t:'ACME-512 in review, ACME-530 waiting for the staging deploy.'},
   {who:'Scrum master',at:'09:44',t:'Thanks all, see you tomorrow.'}]},
  {id:'c3',name:'#qa',kind:'channel',unread:1,sum:'QA asks when ACME-530 will be on staging.',msgs:[
   {who:'Lena Ortiz',at:'10:22',t:'Any ETA for ACME-530 on staging? We planned it for tomorrow.'}]},
  {id:'c4',name:'Sam Rivera',kind:'direct',unread:1,sum:'Asks about rate limiting; your reply waits in Approvals.',msgs:[
   {who:'Sam Rivera',at:'yesterday',t:'Hi, is the rate limiting live yet? A customer asked again.'}]}];

/* work items as the bridge's work get returns them, by id; the fake gateway and the demo context preview read these */
export const work: Record<string, WorkDoc> ={
 'ACME-512':{type:'Story',title:'Public API: rate limiting per token',state:'In Progress',assignedTo:'You',
  description:'Requests to the public API are limited per token, not per user, so one noisy integration cannot starve the others.\n\nThe error banner a limited token sees: [image 1]',
  reproSteps:'',
  acceptanceCriteria:'- A token over its limit gets 429 with a Retry-After header.\n- The limit is read from the gateway\'s existing token bucket.',
  comments:[{id:'1',author:'Dana',at:'2026-09-24T12:10:00Z',text:'Per token, as agreed with the PO.'},
   {id:'2',author:'Priya Shah',at:'2026-09-25T15:40:00Z',text:'The bucket already exists in the gateway; reusing it.'}],
  images:[{ref:'acme-512-1',name:'limit-banner.png',from:'description'}]},
 'ACME-530':{type:'Story',title:'Search: index archived projects',state:'In Progress',assignedTo:'Sam Rivera',
  description:'Archived projects show up in search results, marked as archived.',reproSteps:'',
  acceptanceCriteria:'- An archived project is found by name.\n- Its result carries an Archived badge.',
  comments:[{id:'1',author:'Lena Ortiz',at:'2026-09-29T13:22:00Z',text:'Any ETA on staging? QA planned it for tomorrow.'}]},
};

/* canned LLM reply drafts, per chat and author; the greeting goes in front */
export const cdr: Record<string, string> ={'c1/Priya':'thanks, I will rename the limiter in the same PR.','c1/Tom':'thanks, it only needs your approval now.',
 'c3/Lena':'ACME-530 is waiting for the staging deploy window; I will confirm here as soon as it is on staging.',
 'c4/Sam':'rate limiting is in review (PR #482), one approval left. I will write here once it is on staging.'};

/** LLM reply drafts for the demo mail */
export const mdr: Record<string, string> = {
  m1: 'hi,\nthanks, I am on SUP-77 today and will update the ticket with what I find.',
  m2: 'hi Priya,\nsure, you will have the Q3 usage export by Friday, in the same format as last time.',
  m3: 'hi,\na quick follow-up: can ACME-530 go into tomorrow’s staging window?',
  m4: 'hi,\nthanks, noted.',
}

export const mail: Mail[] =[
 {id:'m1',cat:'reply',from:'Support desk',subj:'SUP-77 assigned to your team',at:'09:58',sum:'A support ticket is assigned to the team; a reply is expected today.',body:'Ticket SUP-77 has been assigned to your team.\nSummary: the weekly report is not generated.',job:'J-0419'},
 {id:'m2',cat:'reply',from:'Priya Shah',subj:'Usage export for Q3',at:'08:20',sum:'Asks for the Q3 usage export by Friday.',body:'Hi,\ncould you export the Q3 usage numbers by Friday? Same format as last time.'},
 {id:'m3',cat:'wait',from:'You → Release team',subj:'ACME-530 staging window',at:'yesterday',sum:'Waiting for the staging deploy window to be confirmed.',body:'Hi, could ACME-530 go into tomorrow’s staging window?',job:'J-0418'},
 {id:'m4',cat:'fyi',from:'Engineering office',subj:'Sprint 41 goals',at:'07:40',sum:'Sprint goals: rate limiting and search.',body:'Sprint 41 goals are published on the team page.'},
 {id:'m5',cat:'auto',from:'GitHub',subj:'PR #482: Priya Shah approved',at:'08:47',sum:'Approved, one comment.',body:'Priya Shah approved pull request #482.'},
 {id:'m6',cat:'auto',from:'Jenkins',subj:'main #1288 passed',at:'07:15',sum:'main, 14 min.',body:'Build main #1288 passed.'}];

/* calendar: this week and next as the bridge returns them, placed around today in home-zone wall time */
export function demoCal(now = Date.now()): GatewayItem[] {
  const days = [...weekDays(0, now), ...weekDays(1, now)], today = dayOf(now)
  const ev = (id: string, day: string, at: string, min: number, subject: string, organizer: string, o: { cancelled?: 1; noJoin?: 1 } = {}) => {
    const start = new Date(fromWall(Date.parse(`${day}T${at}:00Z`))).toISOString()
    return { id, subject, start, end: new Date(Date.parse(start) + min * 60e3).toISOString(), organizer, joinUrl: o.noJoin ? null : `https://zoom.example/j/${id}`,
      response: 'accepted', cancelled: !!o.cancelled, link: `https://zoom.example/meeting/${id}` }
  }
  return [
    ...days.flatMap((d, i) => (i % 7 < 5 ? [ev(`su${i}`, d, '09:30', 15, 'Daily stand-up', 'Scrum master')] : [])),
    ev('rf', today, '11:00', 60, 'Backlog refinement', 'Dana'), ev('oo', today, '14:00', 30, '1:1', 'Priya Shah'),
    ev('dw', today, '16:00', 30, 'Staging deploy window', 'Release bot', { noJoin: 1 }), ev('rt', days[4], '15:00', 60, 'Retro', 'Scrum master', { cancelled: 1 }),
    ev('pl', days[7], '10:00', 120, 'Sprint planning', 'Scrum master'), ev('rv', days[10], '13:00', 90, 'Sprint review', 'Dana'),
  ].sort((a, b) => a.start.localeCompare(b.start))
}

/* today: activity = what you and your LLM runs did */
export const log: LogEntry[] =[
  {at:'10:48',job:'J-0301',a:'LLM',l:'wait',t:'Weekly status draft is ready for review'},
  {at:'10:40',job:'J-0301',a:'you',l:'cur',t:'Asked the LLM to draft the weekly status'},
  {at:'10:05',job:'J-0412',a:'you',l:'off',t:'Noted: Tom Becker reviews after lunch'},
  {at:'09:12',job:'J-0412',a:'you',l:'ok',t:'Sent the review post to #team-dev'},
  {at:'08:02',job:'J-0420',a:'you',l:'ok',t:'Accepted the LLM reply to Sam, with one edit'}];
