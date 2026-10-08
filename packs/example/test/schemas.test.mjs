// The shared schemas accept what a generic pack returns and still accept the example pack's minimum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schema, validate } from './validate.mjs';

const detail = {
  type: 'Bug', title: 'Login fails', state: 'Active', assignedTo: 'Robin Park',
  description: 'It fails.', reproSteps: '1. Open', acceptanceCriteria: 'It works.',
  comments: [], link: 'https://tracker.example/1',
};

test('work.get takes the header, the text sections and chosen fields', () => {
  const fields = [
    { ref: 'Microsoft.VSTS.Common.Priority', name: 'Priority', value: 2 },
    { ref: 'System.Tags', name: 'Tags', value: 'api; auth' },
    { ref: 'Custom.Blocked', name: 'Blocked', value: false },
    { ref: 'Custom.Owner', name: 'Owner', value: null },
  ];
  assert.deepEqual(validate(schema('work.get'), { ...detail, fields }), []);
  assert.deepEqual(validate(schema('work.get'), { ...detail, assignedTo: null }), []);
});

test('work.get refuses a field without a name or with an object value', () => {
  const s = schema('work.get');
  assert.ok(validate(s, { ...detail, fields: [{ ref: 'System.Tags', value: 'x' }] }).some((e) => /name: missing/.test(e)));
  assert.ok(validate(s, { ...detail, fields: [{ ref: 'System.Tags', name: 'Tags', value: { a: 1 } }] }).length > 0);
});

test('work.get still takes the example pack minimum', () => {
  assert.deepEqual(validate(schema('work.get'), { description: '', comments: [] }), []);
});

test('a board item may name its swimlane', () => {
  const item = { id: '1', type: 'Bug', title: 't', state: 'New', column: 'Ready', lane: 'free', assignedTo: null, changedAt: '2026-09-30T12:00:00Z', link: 'https://tracker.example/1' };
  assert.deepEqual(validate(schema('board.item'), { ...item, swimlane: 'Expedite' }), []);
  assert.deepEqual(validate(schema('board.item'), { ...item, swimlane: null }), []);
  assert.deepEqual(validate(schema('board.item'), item), []);
});
