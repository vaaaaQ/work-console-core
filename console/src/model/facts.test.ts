import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FACT_KINDS, FactError, factLamp, factLine, factsIn, latestFacts, missingKinds, stripParts } from './facts.ts'
import type { Fact } from './facts.ts'

const bad = (v: unknown, re: RegExp) => assert.throws(() => factsIn(v), (e: unknown) => e instanceof FactError && re.test(e.message), JSON.stringify(v))

test('the six kinds are fixed in the core', () => {
  assert.deepEqual([...FACT_KINDS], ['branch', 'pr', 'review', 'deploy', 'check', 'round'])
})

test('each kind a run reports validates, trimmed, with only the fields it knows', () => {
  const got = factsIn([
    { kind: 'branch', repo: ' core ', name: 'job/ad-0016', sha: '3F2C9E1', base: 'master', extra: 'dropped' },
    { kind: 'pr', url: 'https://git.example/core/pull/41', n: 41, state: 'open', checks: [{ name: 'build', state: 'pass' }, { name: 'test', state: 'fail', url: 'https://ci.example/7' }] },
    { kind: 'review', by: 'Ann', verdict: 'sent_back', of: 'abc1234', note: 'rename it' },
    { kind: 'deploy', what: 'console', where: 'this PC', version: 'core 3f2c9e1', ok: true },
    { kind: 'check', name: 'rounds view', ok: false, against: '3f2c9e1', art: 'rounds.png' },
    { kind: 'deploy', none: ' docs only ' },
  ])
  assert.deepEqual(got, [
    { kind: 'branch', repo: 'core', name: 'job/ad-0016', sha: '3f2c9e1', base: 'master' },
    { kind: 'pr', url: 'https://git.example/core/pull/41', n: 41, state: 'open', checks: [{ name: 'build', state: 'pass' }, { name: 'test', state: 'fail', url: 'https://ci.example/7' }] },
    { kind: 'review', by: 'Ann', verdict: 'sent_back', of: 'abc1234', note: 'rename it' },
    { kind: 'deploy', what: 'console', where: 'this PC', version: 'core 3f2c9e1', ok: true },
    { kind: 'check', name: 'rounds view', ok: false, against: '3f2c9e1', art: 'rounds.png' },
    { kind: 'deploy', none: 'docs only' },
  ])
  assert.deepEqual(factsIn(undefined), [])
})

test('a bad fact is refused with a message the run can act on', () => {
  bad('x', /a list/)
  bad([{ kind: 'tag' }], /fact 1: kind is one of branch, pr, review, deploy, check, round/)
  bad([{ kind: 'branch', repo: 'core', name: 'b' }], /fact 1 \(branch\): sha is missing/)
  bad([{ kind: 'branch', repo: 'core', name: 'b', sha: 'not-a-sha' }], /sha is a commit hash/)
  bad([{ kind: 'pr', url: 'ftp://git.example/1', state: 'open', checks: [] }], /url is an http\(s\) address/)
  bad([{ kind: 'pr', url: 'javascript:alert(1)', state: 'open', checks: [] }], /url is an http\(s\) address/)
  bad([{ kind: 'pr', url: 'https://git.example/1', state: 'draft', checks: [] }], /state is one of open, merged, closed/)
  bad([{ kind: 'pr', url: 'https://git.example/1', state: 'open', checks: [{ name: 'b', state: 'green' }] }], /check 1: state is one of pass, fail, pending/)
  bad([{ kind: 'deploy', what: 'x', where: 'y', version: 'z' }], /ok is true or false/)
  bad([{ kind: 'check', name: 'x'.repeat(301), ok: true }], /name is longer than 300 characters/)
  bad([{ kind: 'check', name: 'x', ok: true, note: 'n'.repeat(1001) }], /note is longer than 1000/)
  bad([{ kind: 'deploy', none: '  ' }], /none says why/)
  bad(Array.from({ length: 21 }, () => ({ kind: 'deploy', none: 'x' })), /at most 20/)
  // a round is the console's own; a run never reports one
  bad([{ kind: 'round', n: 1, back_to: 'a', why: 'x', failed: [] }], /the console writes round/)
})

test('missingKinds names the declared kinds a list lacks; a none fact counts', () => {
  const fx = factsIn([{ kind: 'branch', repo: 'r', name: 'b', sha: 'abcdef1' }, { kind: 'deploy', none: 'docs only' }])
  assert.deepEqual(missingKinds(['branch', 'deploy', 'pr'], fx), ['pr'])
  assert.deepEqual(missingKinds(undefined, fx), [])
})

test('latestFacts keeps the newest of each kind, in kind order', () => {
  const f = (o: Partial<Fact> & { kind: Fact['kind'] }, at: string, step = 's1') => ({ ...o, at, step }) as Fact
  const list = [
    f({ kind: 'branch', repo: 'r', name: 'b', sha: 'aaaaaaa' }, '2026-10-01T00:00:00Z'),
    f({ kind: 'check', name: 'c', ok: false }, '2026-10-02T00:00:00Z'),
    f({ kind: 'branch', repo: 'r', name: 'b', sha: 'bbbbbbb' }, '2026-10-03T00:00:00Z', 's2'),
  ]
  const l = latestFacts(list)
  assert.deepEqual(l.map((x) => x.kind), ['branch', 'check'])
  assert.equal((l[0] as { sha: string }).sha, 'bbbbbbb')
})

test('factLine says each kind in one line, links on names, with the step that made it', () => {
  const t = (id: string) => ({ s1: 'TDD on the job branch', s0: 'Build' })[id] ?? id
  const m = { at: '2026-10-01T00:00:00Z', step: 's1' }
  assert.equal(factLine({ kind: 'branch', repo: 'core', name: 'job/ad-0016', sha: '3f2c9e1', ...m }, t),
    'branch job/ad-0016 at 3f2c9e1 (repo core; from "TDD on the job branch")')
  assert.equal(factLine({ kind: 'pr', url: 'https://git.example/41', n: 41, state: 'open', checks: [{ name: 'build', state: 'pass' }, { name: 'test', state: 'fail', url: 'https://ci.example/7' }], ...m }, t),
    'pr [#41](https://git.example/41) open; checks: build pass, test fail ([test](https://ci.example/7)) (from "TDD on the job branch")')
  assert.equal(factLine({ kind: 'deploy', what: 'console', where: 'this PC', version: 'core 3f2c9e1', ok: true, ...m }, t),
    'deploy console at core 3f2c9e1 on this PC: ok (from "TDD on the job branch")')
  assert.equal(factLine({ kind: 'check', name: 'rounds view', ok: false, against: '3f2c9e1', url: 'https://ci.example/8', ...m }, t),
    'check "rounds view" failed against 3f2c9e1 ([evidence](https://ci.example/8)) (from "TDD on the job branch")')
  assert.equal(factLine({ kind: 'review', by: 'Ann', verdict: 'sent_back', note: 'rename it', ...m }, t),
    'review sent back by Ann: rename it (from "TDD on the job branch")')
  assert.equal(factLine({ kind: 'round', n: 1, back_to: 's0', why: 'smoke failed', failed: ['rounds view'], ...m }, t),
    'round 1 → back to "Build": smoke failed; failed: rounds view (from "TDD on the job branch")')
  assert.equal(factLine({ kind: 'deploy', none: 'docs only', ...m }, t), 'deploy: none, docs only (from "TDD on the job branch")')
})

test('stripParts: the job header strip, the latest of each kind but round, each with its lamp', () => {
  const m = (at: string) => ({ at, step: 's' })
  const fx: Fact[] = [
    { kind: 'branch', repo: 'core', name: 'job/x', sha: '3f2c9e1aaaaaaaaaa', ...m('1') },
    { kind: 'pr', url: 'https://git.example/41', n: 41, state: 'open', checks: [{ name: 'a', state: 'pass' }, { name: 'b', state: 'pass' }, { name: 'c', state: 'fail' }], ...m('2') },
    { kind: 'deploy', what: 'console', where: 'this PC', version: '3f2c9e1', ok: true, ...m('3') },
    { kind: 'check', name: 'live check', ok: true, ...m('4') },
    { kind: 'round', n: 1, back_to: 's', why: 'x', failed: [], ...m('5') },
  ]
  assert.deepEqual(stripParts(fx), [
    { kind: 'branch', l: 'ok', t: 'job/x @ 3f2c9e1aaaaa' },
    { kind: 'pr', l: 'bad', t: 'PR #41 open ✓2 ✗1', url: 'https://git.example/41' },
    { kind: 'deploy', l: 'ok', t: 'deployed 3f2c9e1' },
    { kind: 'check', l: 'ok', t: 'live check ✓' },
  ])
  assert.deepEqual(stripParts([{ kind: 'deploy', none: 'docs only', ...m('1') }, { kind: 'review', by: 'A', verdict: 'sent_back', ...m('2') }]),
    [{ kind: 'review', l: 'bad', t: 'review: sent back' }, { kind: 'deploy', l: 'off', t: 'deploy: none' }])
  assert.equal(factLamp({ kind: 'pr', url: 'https://g.example', state: 'open', checks: [{ name: 'a', state: 'pending' }] }), 'wait')
  assert.equal(factLamp({ kind: 'check', name: 'x', ok: false }), 'bad')
  assert.equal(factLamp({ kind: 'round', n: 1, back_to: 's', why: 'x', failed: [] }), 'cur')
})
