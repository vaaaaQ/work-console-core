import type { BadgeKind, JobStatus, Lamp, Mode, NodeState, SrcKey } from '../model/types.ts'

export const MODES: Record<Mode, { l: string; i: string }> ={you:{l:'You',i:'user'},llm:{l:'Ask LLM',i:'bot'}};
export const EXEC: Record<Mode, string> ={you:'You do it, then mark it done',llm:'You ask the LLM; it returns a draft you accept, edit or reject'};
export const STATUS: Record<JobStatus, { l: string; c: Lamp; h?: 1; p?: 1 }> ={
 draft:{l:'draft',c:'off'},
 ready:{l:'ready',c:'off',h:1},
 active:{l:'in progress',c:'cur'},
 'waiting-user':{l:'needs you',c:'wait',p:1},
 'waiting-external':{l:'waiting on others',c:'wait',h:1},
 review:{l:'in review',c:'cur',h:1},
 recurring:{l:'recurring',c:'ok',h:1},
 done:{l:'done',c:'ok'},
 cancelled:{l:'cancelled',c:'off',h:1}
};
export const NODE: Record<NodeState, [Lamp, string]> ={done:['ok','done'],cur:['cur','in progress'],wait:['wait','waiting'],bad:['bad','problem'],fut:['off','not started'],tpl:['tpl','message planned'],skip:['off','skipped']};
export const BK: Record<BadgeKind, { l: string; i: string }> ={q:{l:'Question',i:'help'},c:{l:'Contradiction',i:'neq'},d:{l:'Design note',i:'pen'},p:{l:'Problem',i:'alert'}};
/* core concepts a pack maps its tools onto */
export const CORE: [SrcKey, string, string][] =[
 ['work','Work tracker','where a job’s key points'],
 ['review','Code review','pull requests and their votes'],
 ['chat','Chat','threads you read, reply to and post in'],
 ['mail','Mail','Inbox and Sent'],
 ['cal','Calendar','today’s meetings'],
 ['ci','CI','builds a step waits for'],
 ['tickets','Tickets','incidents and requests'],
 ['docs','Docs','pages a step reads or writes'],
 ['time','Time tracking','recurring timesheets']
];
