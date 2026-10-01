import type { Pack, Ws } from '../model/types.ts'

/* ===== workspace packs: tools, vocabulary, review rule, playbooks, data =====
   A pack maps a workplace's tools onto the core concepts. Acme is the fictional demo workplace;
   a real one adds its own entry here and its bridge pack under packs/ at the repo root. */
export const PACKS: Record<Ws, Pack> ={
 acme:{n:'Acme',d:'Jira, GitHub, Slack, Jenkins, Zoom, Confluence',tz:null,tzl:'',keyPh:'ACME-123',strip:null,prj:['platform','web','ops'],
  src:{work:{n:'Jira',item:'issue'},review:{n:'GitHub',item:'pull request'},chat:{n:'Slack'},mail:{n:'Email'},
   cal:{n:'Zoom',item:'meeting'},ci:{n:'Jenkins',item:'build'},tickets:{n:'Jira',item:'support ticket'},docs:{n:'Confluence',item:'page'}},
  votes:{'1':'approved','0':'commented','-1':'changes requested'},ok:1,veto:-1,
  rule:'Two approvals, and no changes requested.',people:{po:'Dana'}}
};
/** the workspace the page opens in, and the one jobs from a removed workspace land in */
export const DEFAULT_WS: Ws = 'acme'
