import type { Pack } from '../../../src/model/types.ts'

/* Acme, the fictional demo workplace: its tools mapped onto the core concepts, vocabulary and review rule */
export const pack: Pack ={n:'Acme',d:'Jira, GitHub, Slack, Jenkins, Zoom, Confluence',tz:null,tzl:'',keyPh:'ACME-123',strip:null,prj:['platform','web','ops'],
  src:{work:{n:'Jira',item:'issue'},review:{n:'GitHub',item:'pull request'},chat:{n:'Slack'},mail:{n:'Email'},
   cal:{n:'Zoom',item:'meeting'},ci:{n:'Jenkins',item:'build'},tickets:{n:'Jira',item:'support ticket'},docs:{n:'Confluence',item:'page'},time:{n:'Timesheet'}},
  votes:{'1':'approved','0':'commented','-1':'changes requested'},ok:1,veto:-1,
  rule:'Two approvals, and no changes requested.',people:{po:'Dana'}};
