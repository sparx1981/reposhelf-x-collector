import {createHash} from 'node:crypto';

export const sourceCategory = 'As Seen On X.com';
export const iso = time => new Date(time).toISOString();
export function initialState(now = Date.now()) {
  return {schema: 1, reservedUsd: 0, requests: 0, queryTurn: 0, queries: {}, candidates: {}, lastRun: null};
}
export function validateConfig(c) {
  if (!Array.isArray(c.queries) || !c.queries.length || c.queries.some(q => typeof q !== 'string' || !q.trim() || q.length > 512)) throw Error('Invalid search queries');
  for (const key of ['historyDays', 'pageSize', 'maxPostsPerRun', 'maxRepositoriesPerRun']) if (!Number.isInteger(c[key]) || c[key] <= 0) throw Error('Invalid ' + key);
  if (c.historyDays > 90 || c.pageSize < 10 || c.pageSize > 100 || c.maxPostsPerRun > 100) throw Error('Search limits exceed pilot bounds');
  for (const key of ['minimumFreeBalanceUsd', 'maximumReservedUsd', 'conservativePostCostUsd', 'maximumReservedPerRunUsd']) if (!Number.isFinite(c[key]) || c[key] <= 0) throw Error('Invalid ' + key);
  if (c.minimumFreeBalanceUsd < 2 || c.maximumReservedUsd > 18 || c.conservativePostCostUsd < 0.01 || c.maximumReservedPerRunUsd > 0.5) throw Error('Credit limits exceed the free pilot');
  return c;
}
export function creditAllowance(balance, config, state, runReserved = 0, now = Date.now()) {
  const data = balance?.data;
  if (balance?.errors?.length || !data || typeof data.free_balance !== 'number' || typeof data.prepaid_balance !== 'number' || typeof data.total_balance !== 'number' || ![data.free_balance, data.prepaid_balance, data.total_balance].every(Number.isFinite)) return {posts: 0, reason: 'credit_balance_unverified'};
  if (data.prepaid_balance < 0) return {posts: 0, reason: 'negative_prepaid_balance'};
  const grants = data.free_grants;
  if (!Array.isArray(grants) || !grants.length || grants.some(g => !Number.isFinite(Date.parse(g.expires_at)) || Date.parse(g.expires_at) <= now + 3600000)) return {posts: 0, reason: 'free_credit_expiry_unverified_or_near'};
  const usd = Math.min(data.free_balance - config.minimumFreeBalanceUsd, data.total_balance - config.minimumFreeBalanceUsd, config.maximumReservedUsd - state.reservedUsd, config.maximumReservedPerRunUsd - runReserved);
  const posts = Math.max(0, Math.floor((usd + 1e-9) / config.conservativePostCostUsd));
  return {posts, reason: posts < 10 ? 'credit_reserve_reached' : null, freeBalanceUsd: data.free_balance};
}
export function repoFromUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com' || u.port || u.username || u.password) return null;
    const [owner, raw] = u.pathname.split('/').filter(Boolean), repo = raw?.replace(/\.git$/i, '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner || '') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo || '') || ['.', '..'].includes(repo)) return null;
    if (['features', 'topics', 'collections', 'settings', 'marketplace', 'search', 'orgs', 'users', 'login', 'sponsors', 'about', 'site', 'apps', 'events', 'notifications', 'explore', 'contact', 'pricing', 'readme', 'security', 'enterprise'].includes(owner.toLowerCase())) return null;
    return owner + '/' + repo;
  } catch { return null; }
}
export function addPosts(state, posts, query, now = Date.now()) {
  for (const post of posts) {
    if (!/^\d{1,25}$/.test(String(post.id))) continue;
    const urls = [...(post.entities?.urls || []), ...(post.note_tweet?.entities?.urls || []), ...(post.note_post?.entities?.urls || [])];
    const values = urls.flatMap(u => [u.unwound_url, u.expanded_url, u.url]).filter(Boolean);
    values.push(...(String(post.text || '').match(/https:\/\/github\.com\/[^\s<>]+/g) || []).map(v => v.replace(/[),.;]+$/, '')));
    const names = [...new Set(values.map(repoFromUrl).filter(Boolean))];
    for (const full of names) {
      const key = full.toLowerCase(), source = {kind: 'x', name: sourceCategory, url: 'https://x.com/i/web/status/' + post.id, postId: String(post.id), postedAt: post.created_at || null};
      const candidate = state.candidates[key] ||= {full, firstSeenAt: iso(now), status: 'queued', sources: []};
      if (!candidate.sources.some(s => s.postId === source.postId)) candidate.sources.push(source);
      candidate.sources = candidate.sources.slice(-20);
      candidate.lastSeenAt = iso(now);
    }
  }
}
export function queryKey(query) { return createHash('sha256').update(query).digest('hex').slice(0, 16); }
export function queryState(state, query, config, now = Date.now()) {
  return state.queries[queryKey(query)] ||= {query, history: {start: iso(now - config.historyDays * 86400000), end: iso(now - 30000), done: false}, recent: {start: iso(now - 86400000)}};
}
export function dueCandidates(state, now = Date.now()) {
  return Object.values(state.candidates).filter(c => c.status !== 'rejected' && c.status !== 'known' && (!c.nextAttemptAt || Date.parse(c.nextAttemptAt) <= now)).sort((a, b) => Date.parse(a.nextAttemptAt || a.firstSeenAt) - Date.parse(b.nextAttemptAt || b.firstSeenAt));
}
export function safeSource(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['x.com', 'twitter.com'].includes(u.hostname) && /\/(?:[^/]+\/status|i\/web\/status)\/\d+$/.test(u.pathname) && !u.username && !u.password && !u.port; } catch { return false; }
}
