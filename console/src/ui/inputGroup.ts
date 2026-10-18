import { createElement as h } from 'react'

/* The Artifacts panel's Input group: the web pages the job started from, from its context and its playbook. Each
   opens in a new tab, never in the artifact viewer, which reads files the runs wrote. */

export function InputGroup({ links }: { links: { name: string; url: string }[] }) {
  if (!links.length) return null
  return h('div', { className: 'ag' }, h('h4', null, 'Input'), h('ul', { className: 'al ai' }, links.map((l) => h('li', { key: l.url },
    h('span', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.name)), h('span', { className: 'why' }, 'link')))))
}
