import * as React from 'react'
import { Lexer } from 'marked'
import type { Token, Tokens } from 'marked'

/* Markdown for the artifact viewer, built as React elements from marked's tokens. No HTML string
   reaches the DOM: an LLM run writes these files from chats and mail, and a script in the page
   would act with the device's cookie. Raw HTML in a file shows as text. */

const h = React.createElement
const EXT = { target: '_blank', rel: 'noopener noreferrer' }

/** a link the viewer follows: web and mail only */
export const safeHref = (u: string) => (/^(https?|mailto):/i.test(u.trim()) ? u.trim() : null)

const inl = (ts: Token[] | undefined) => (ts || []).map(inline)

function inline(t: Token, key: number): React.ReactNode {
  switch (t.type) {
    case 'strong': case 'em': case 'del': return h(t.type, { key }, inl(t.tokens))
    case 'codespan': return h('code', { key }, t.text)
    case 'br': return h('br', { key })
    case 'checkbox': return h('input', { key, type: 'checkbox', disabled: true, checked: (t as Tokens.Checkbox).checked, readOnly: true })
    case 'link': case 'image': {
      const u = safeHref((t as Tokens.Link).href), body = t.type === 'image' ? t.text || t.href : inl(t.tokens)
      return u ? h('a', { key, href: u, ...EXT }, body) : h(React.Fragment, { key }, body)
    }
    case 'text': return t.tokens ? h(React.Fragment, { key }, inl(t.tokens)) : t.text
    case 'html': case 'escape': return t.text
    default: return t.raw
  }
}

const blocks = (ts: Token[]) => ts.map(block)

function block(t: Token, key: number): React.ReactNode {
  switch (t.type) {
    case 'space': return null
    case 'heading': return h('h' + (t as Tokens.Heading).depth, { key }, inl(t.tokens))
    case 'paragraph': return h('p', { key }, inl(t.tokens))
    case 'text': case 'checkbox': return inline(t, key)
    case 'code': return h('pre', { key }, h('code', null, t.text))
    case 'blockquote': return h('blockquote', { key }, blocks(t.tokens || []))
    case 'hr': return h('hr', { key })
    case 'html': return h('p', { key }, t.text)
    case 'list': {
      const l = t as Tokens.List
      return h(l.ordered ? 'ol' : 'ul', { key, start: l.ordered && l.start !== 1 && l.start !== '' ? Number(l.start) : undefined },
        l.items.map((it, i) => h('li', { key: i }, blocks(it.tokens))))
    }
    case 'table': {
      const tb = t as Tokens.Table, al = (i: number) => (tb.align[i] ? { textAlign: tb.align[i]! } : undefined)
      return h('div', { key, className: 'tw' }, h('table', { className: 'mt' },
        h('thead', null, h('tr', null, tb.header.map((c, i) => h('th', { key: i, style: al(i) }, inl(c.tokens))))),
        h('tbody', null, tb.rows.map((r, i) => h('tr', { key: i }, r.map((c, j) => h('td', { key: j, style: al(j) }, inl(c.tokens))))))))
    }
    default: return t.raw ? h('p', { key }, t.raw) : null
  }
}

export const md = (src: string): React.ReactNode => h(React.Fragment, null, blocks(Lexer.lex(src, { gfm: true })))
