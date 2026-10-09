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
  for (const key of ['minimumBalanceUsd', 'conservativePostCostUsd', 'maximumReservedPerRunUsd']) if (!Number.isFinite(c[key]) || c[key] <= 0) throw Error('Invalid ' + key);
  if (c.minimumBalanceUsd < 2 || c.conservativePostCostUsd < 0.01 || c.maximumReservedPerRunUsd > 1) throw Error('Credit limits exceed the collection bounds');
  return c;
}
export function creditAllowance(balance, config, state, runReserved = 0, now = Date.now()) {
  const data = balance?.data;
  if (balance?.errors?.length || !data || typeof data.free_balance !== 'number' || typeof data.prepaid_balance !== 'number' || typeof data.total_balance !== 'number' || ![data.free_balance, data.prepaid_balance, data.total_balance].every(Number.isFinite)) return {posts: 0, reason: 'credit_balance_unverified'};
  if (data.prepaid_balance < 0) return {posts: 0, reason: 'negative_prepaid_balance'};
  if (data.free_balance < 0 || data.total_balance < 0) return {posts: 0, reason: 'negative_credit_balance'};
  const usd = Math.min(data.total_balance - config.minimumBalanceUsd, config.maximumReservedPerRunUsd - runReserved);
  const posts = Math.max(0, Math.floor((usd + 1e-9) / config.conservativePostCostUsd));
  return {posts, reason: posts < 10 ? 'credit_reserve_reached' : null, freeBalanceUsd: data.free_balance, totalBalanceUsd: data.total_balance};
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
    const text=[post.text,post.note_tweet?.text,post.note_post?.text].filter(Boolean).join('\n');
    values.push(...(text.match(/https:\/\/[^\s<>]+/g) || []).map(v => v.replace(/[),.;]+$/, '')));
    const names = [...new Set(values.map(repoFromUrl).filter(Boolean))];
    const demos=/\b(demo|playground|interactive|try|live\s*(app|preview|site)|deployed|launched)\b/i.test(text)?[...new Set(values.map(demoHint).filter(Boolean))].slice(0,5):[];
    const metrics=post.public_metrics||{},engagement={likes:Number(metrics.like_count)||0,reposts:Number(metrics.retweet_count)||0,replies:Number(metrics.reply_count)||0,quotes:Number(metrics.quote_count)||0};
    state.postIds||=[];const repeated=state.postIds.includes(String(post.id));
    state.postIds=[...state.postIds.filter(id=>id!==String(post.id)),String(post.id)].slice(-5000);
    const stats=(state.queryStats||={})[queryKey(query)]||={query,posts:0,uniquePosts:0,newCandidates:0};stats.posts++;if(!repeated)stats.uniquePosts++;
    if(!names.length&&demos.length){state.demoSeeds||={};for(const url of demos){const seed=state.demoSeeds[url]||={url,sources:[],firstSeenAt:iso(now),query,engagement};if(!seed.sources.some(s=>s.postId===String(post.id)))seed.sources.push({kind:'x',name:sourceCategory,url:'https://x.com/i/web/status/'+post.id,postId:String(post.id),postedAt:post.created_at||null});seed.sources=seed.sources.slice(-20);}}
    for (const full of names) {
      const key = full.toLowerCase(), source = {kind: 'x', name: sourceCategory, url: 'https://x.com/i/web/status/' + post.id, postId: String(post.id), postedAt: post.created_at || null};
      if(!state.candidates[key])stats.newCandidates++;
      const candidate = state.candidates[key] ||= {full, firstSeenAt: iso(now), status: 'queued', sources: [],query};
      candidate.engagement=Object.fromEntries(Object.entries(engagement).map(([key,value])=>[key,Math.max(value,candidate.engagement?.[key]||0)]));
      if(names.length===1){candidate.demoHints=[...new Set([...(candidate.demoHints||[]),...demos])].slice(0,5);candidate.demoLinks=[...new Map([...(candidate.demoLinks||[]),...demos.map(url=>({url,postUrl:source.url,repository:full}))].map(v=>[v.url,v])).values()].slice(0,5);if(demos.length&&candidate.reason==='no_hosted_demo'){candidate.nextAttemptAt=iso(now);candidate.status='queued';}}
      if (!candidate.sources.some(s => s.postId === source.postId)) candidate.sources.push(source);
      candidate.sources = candidate.sources.slice(-20);
      candidate.lastSeenAt = iso(now);
    }
  }
}
export function queryKey(query) { return createHash('sha256').update(query).digest('hex').slice(0, 16); }
export function queryState(state, query, config, now = Date.now()) {
  return state.queries[queryKey(query)] ||= {query, history: {start: iso(now - config.historyDays * 86400000), end: iso(now - 7 * 86400000), done: false}, recent: {start: iso(now - 7 * 86400000 + 60000)}};
}
export function dueCandidates(state, now = Date.now()) {
  return Object.values(state.candidates).filter(c => c.status !== 'rejected' && c.status !== 'known' && (!c.nextAttemptAt || Date.parse(c.nextAttemptAt) <= now)).sort((a,b)=>priority(b,now)-priority(a,now)||Date.parse(a.firstSeenAt)-Date.parse(b.firstSeenAt));
}
export function demoHint(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;const h=u.hostname.toLowerCase();if(/(^|\.)(github\.com|twitter\.com|x\.com|t\.co|youtube\.com|youtu\.be|githubusercontent\.com|imgur\.com|shields\.io)$/.test(h)||/\.(png|jpe?g|gif|svg|webp|mp4|webm|pdf|zip)$/i.test(u.pathname))return null;if(!h.includes('.')||h==='localhost'||h.endsWith('.local'))return null;return u.href}catch{return null}}
export function priority(c,now=Date.now()){const m=c.engagement||{},age=Math.max(6,(now-Date.parse(c.sources?.at(-1)?.postedAt||c.firstSeenAt))/3600000),score=Math.log1p((m.likes||0)+3*(m.reposts||0)+2*(m.quotes||0)+(m.replies||0))/Math.sqrt(Number.isFinite(age)?age:24);return (c.status==='queued'?100:c.status==='accepted'?0:20)+(c.demoHints?.length?20:0)+score;}
export function safeSource(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['x.com', 'twitter.com'].includes(u.hostname) && /\/(?:[^/]+\/status|i\/web\/status)\/\d+$/.test(u.pathname) && !u.username && !u.password && !u.port; } catch { return false; }
}
