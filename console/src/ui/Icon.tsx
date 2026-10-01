import * as React from 'react'

/** a symbol from the sprite in index.html */
export function Ic({ n, sm }: { n: string; sm?: boolean }) {
  return <svg className={sm ? 'i sm' : 'i'} aria-hidden="true"><use href={'#i-' + n} /></svg>
}
