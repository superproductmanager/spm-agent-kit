'use strict';
// Tests for lib/item-workspace.cjs: the lookup route, its URL check, and the parse of the reply (spec addendum 1).
// The end-to-end behaviour (the 404, the one lookup, the retry with the header, the refusals) is covered on the stand-in server in agent-reply.cjs --selftest and agent-ack.cjs --selftest.
const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupRoute, parseLookupUrl, workspaceFromLookup, isLookedUpWorkspace, LOOKUP_PATH } = require('../lib/item-workspace.cjs');

const HOST = 'example-backend.invalid';
const MAP = '00000000-0000-4000-8000-00000001000a';
const BOARD = '00000000-0000-4000-8000-00000001000b';
const WS = '00000000-0000-4000-8000-0000000000a2';
const WS_OTHER = '00000000-0000-4000-8000-0000000000a3';

test('the lookup route is the id-filtered list, board or map only, lower-case uuid only', () => {
  assert.equal(LOOKUP_PATH, '/accountApi/me/items');
  assert.equal(lookupRoute('map', MAP), `accountApi/me/items?type=map&id=${MAP}`);
  assert.equal(lookupRoute('board', BOARD), `accountApi/me/items?type=board&id=${BOARD}`);
  assert.throws(() => lookupRoute('document', MAP), /board or map/);
  assert.throws(() => lookupRoute('map', MAP.toUpperCase()), /lower-case uuid/);
  assert.throws(() => lookupRoute('map', 'not-a-uuid'), /lower-case uuid/);
});

test('parseLookupUrl accepts exactly the https lookup on the host with type and id', () => {
  assert.deepEqual(parseLookupUrl(`https://${HOST}/accountApi/me/items?type=map&id=${MAP}`, HOST), { type: 'map', id: MAP });
  assert.equal(parseLookupUrl(`https://${HOST}/accountApi/me/items?id=${MAP}&type=board`, HOST).type, 'board');
  assert.equal(parseLookupUrl(`http://${HOST}/accountApi/me/items?type=map&id=${MAP}`, HOST), null, 'http refused');
  assert.equal(parseLookupUrl(`https://evil.example/accountApi/me/items?type=map&id=${MAP}`, HOST), null, 'other host refused');
  assert.equal(parseLookupUrl(`https://${HOST}:8443/accountApi/me/items?type=map&id=${MAP}`, HOST), null, 'port refused');
  assert.equal(parseLookupUrl(`https://${HOST}/accountApi/me/items?type=map&id=${MAP}&limit=5`, HOST), null, 'extra key refused');
  assert.equal(parseLookupUrl(`https://${HOST}/accountApi/me/items?type=document&id=${MAP}`, HOST), null, 'document refused');
  assert.equal(parseLookupUrl(`https://${HOST}/accountApi/me/items?type=map`, HOST), null, 'no id refused');
  assert.equal(parseLookupUrl(`https://${HOST}/accountApi/me/items?type=map&id=${MAP.toUpperCase()}`, HOST), null, 'upper-case id refused');
  assert.equal(parseLookupUrl(`https://${HOST}/accountApi/inbox?type=map&id=${MAP}`, HOST), null, 'another path refused');
});

test('workspaceFromLookup takes the item workspace_id only when the reply lists that same item', () => {
  const item = (over) => ({ items: [{ type: 'map', id: MAP, title: 't', workspace_id: WS, ...over }], next_cursor: null });
  assert.equal(workspaceFromLookup(item({}), 'map', MAP), WS);
  assert.equal(workspaceFromLookup({ items: [], next_cursor: null }, 'map', MAP), null, 'empty answer');
  assert.equal(workspaceFromLookup(item({ type: 'board' }), 'map', MAP), null, 'wrong type');
  assert.equal(workspaceFromLookup(item({ id: BOARD }), 'map', MAP), null, 'wrong id');
  assert.equal(workspaceFromLookup(item({ workspace_id: null }), 'map', MAP), null, 'no workspace');
  assert.equal(workspaceFromLookup(item({ workspace_id: 'not-a-uuid' }), 'map', MAP), null, 'bad workspace');
  assert.equal(workspaceFromLookup(null, 'map', MAP), null, 'no body');
  assert.equal(workspaceFromLookup(item({ workspace_id: WS_OTHER }), 'map', MAP), WS_OTHER);
});

test('isLookedUpWorkspace admits a header value only when it equals the looked-up workspace', () => {
  assert.equal(isLookedUpWorkspace(WS, WS), true);
  assert.equal(isLookedUpWorkspace(WS_OTHER, WS), false, 'another workspace refused');
  assert.equal(isLookedUpWorkspace(WS, null), false, 'no lookup in this run refused');
  assert.equal(isLookedUpWorkspace(WS, undefined), false, 'undefined refused');
  assert.equal(isLookedUpWorkspace('home-team', 'home-team'), false, 'a slug is never admitted');
});
