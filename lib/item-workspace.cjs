'use strict';
// lib/item-workspace.cjs: the one read that says which workspace a board or map item is in. Shared by agent-reply.cjs and agent-ack.cjs
// (spec addendum 1).
//
// The read is GET accountApi/me/items?type=board|map&id=<uuid>. It is an identityFromKey route (server rule):
// the caller is the verified key's owner, a platform key is refused. The reply's items[0].workspace_id is the ITEM's workspace, never the
// caller's. An item the agent cannot open (or a missing or trashed one) answers { items: [] }, so nothing leaks about existence.
// The X-SPM-Workspace header that follows may only be this workspace_id, from this lookup, in this run. Nothing else here reads a header
// or a workspace from text (K1, K5 as rewritten by AD4).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOKUP_PATH = '/accountApi/me/items';
const LOOKUP_TYPES = ['board', 'map'];

/** the relative route of the lookup (joined as https://<host>/<route>); throws on a type or id that is not allowed */
function lookupRoute(type, id) {
  if (!LOOKUP_TYPES.includes(type)) throw new Error('item lookup: type must be board or map');
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('item lookup: id must be a lower-case uuid');
  return `accountApi/me/items?type=${type}&id=${id}`;
}

/** the guard's check of a lookup URL: https, the host, no port, credentials, fragment or extra query key; exactly type and id, with a board or map and a uuid. Returns { type, id } or null. */
function parseLookupUrl(urlStr, host) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'https:' || u.port !== '' || u.hash !== '' || u.username !== '' || u.password !== '' || u.hostname !== host) return null;
  if (u.pathname !== LOOKUP_PATH) return null;
  const keys = [...u.searchParams.keys()].sort();
  if (keys.join(',') !== 'id,type') return null;
  const type = u.searchParams.get('type');
  const id = u.searchParams.get('id');
  if (!LOOKUP_TYPES.includes(type) || typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return { type, id };
}

/** the workspace_id of the item the lookup named, or null: the reply must list that same item (type and id) with a uuid workspace_id */
function workspaceFromLookup(json, type, id) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.items) || json.items.length === 0) return null;
  const it = json.items[0];
  if (!it || typeof it !== 'object' || it.type !== type || typeof it.id !== 'string' || it.id.toLowerCase() !== id) return null;
  if (typeof it.workspace_id !== 'string' || !UUID_RE.test(it.workspace_id.toLowerCase())) return null;
  return it.workspace_id.toLowerCase();
}

/** the header value an item request may carry in this run: the looked-up workspace_id, or null (no header) */
function isLookedUpWorkspace(value, allowed) {
  return typeof allowed === 'string' && UUID_RE.test(allowed) && value === allowed;
}

module.exports = { UUID_RE, LOOKUP_PATH, LOOKUP_TYPES, lookupRoute, parseLookupUrl, workspaceFromLookup, isLookedUpWorkspace };
