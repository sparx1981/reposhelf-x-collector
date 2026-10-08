import {initialState, validateConfig, creditAllowance, addPosts, queryState, iso} from './core.mjs';
import {readJson, saveJson} from './io.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function collect({config, state, request, save, enabled = async () => false, now = Date.now}) {
  validateConfig(config);
  let read = 0, runReserved = 0, stopped = null;
  const tasks = [];
  const query = config.queries[state.queryTurn % config.queries.length];
  const progress = queryState(state, query, config, now());
  const recent = progress.recent;
  if (!recent.end) recent.end = iso(now() - 30000);
  const lower = now() - 7 * 86400000 + 60000;
  if (Date.parse(recent.start) < lower) {
    state.coverageGaps ||= [];
    state.coverageGaps.push({query, start: recent.start, end: iso(lower)});
    recent.start = iso(lower); delete recent.nextToken;
  }
  tasks.push({endpoint: 'recent', cursor: recent});
  if (!progress.history.done) tasks.push({endpoint: 'all', cursor: progress.history});
  for (const task of tasks) {
    if (read >= config.maxPostsPerRun) break;
    if (!await enabled()) { stopped = 'admin_disabled'; break; }
    let balance;
    try { balance = await request('/2/usage/credits'); }
    catch(error) { if ([402,403,429].includes(error.status)) { stopped = 'x_api_http_' + error.status; break; } throw error; }
    const allowance = creditAllowance(balance, config, state, runReserved, now());
    state.lastFreeBalanceUsd = allowance.freeBalanceUsd ?? null;
    state.lastTotalBalanceUsd = allowance.totalBalanceUsd ?? null;
    const max = Math.min(config.pageSize, config.maxPostsPerRun - read, allowance.posts);
    if (max < 10) { stopped = allowance.reason || 'run_limit'; break; }
    const reserved = Math.round(max * config.conservativePostCostUsd * 1e6) / 1e6;
    state.reservedUsd = Math.round((state.reservedUsd + reserved) * 1e6) / 1e6;
    state.requests++; runReserved += reserved;
    // Persist and push the worst-case allowance BEFORE making a metered request.
    await save(state, true);
    if (!await enabled()) { stopped = 'admin_disabled'; break; }
    const params = new URLSearchParams({query, max_results: String(max), start_time: task.cursor.start, end_time: task.cursor.end, 'tweet.fields': 'created_at,entities'});
    if (task.cursor.nextToken) params.set('next_token', task.cursor.nextToken);
    let response;
    try { response = await request('/2/tweets/search/' + task.endpoint + '?' + params); }
    catch(error) { if ([402,403,429].includes(error.status)) { stopped = 'x_api_http_' + error.status; break; } throw error; }
    const posts = response.data || [];
    if (!Array.isArray(posts) || posts.length > max || response.errors?.length) throw Error('Search response is incomplete or invalid; cursor retained for retry');
    addPosts(state, posts, query, now());
    read += posts.length;
    if (response.meta?.next_token) task.cursor.nextToken = response.meta.next_token;
    else {
      delete task.cursor.nextToken;
      if (task.endpoint === 'all') task.cursor.done = true;
      else { task.cursor.start = iso(Date.parse(task.cursor.end) - 60000); delete task.cursor.end; }
    }
    await save(state, true);
  }
  state.queryTurn++;
  state.lastRun = {at: iso(now()), postsRead: read, reservedUsd: runReserved, stopped, candidateCount: Object.keys(state.candidates).length};
  await save(state, true);
  return state.lastRun;
}

async function main() {
  const config = await readJson('config.json');
  const state = await readJson('state/state.json', initialState());
  if (state.schema !== 1 || !Number.isFinite(state.reservedUsd) || state.reservedUsd < 0 || !Number.isSafeInteger(state.queryTurn)) throw Error('Invalid saved collector state');
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw Error('Missing X_BEARER_TOKEN secret');
  const request = async path => {
    const response = await fetch('https://api.x.com' + path, {headers: {Authorization: 'Bearer ' + token}, redirect: 'error', signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Object.assign(Error('X API returned HTTP ' + response.status + '; no automatic retry'), {status:response.status});
    return response.json();
  };
  const save = async data => {
    await saveJson('state/state.json', data);
    if (process.env.COLLECTOR_CHECKPOINT === 'true') {
      const {checkpoint} = await import('./checkpoint.mjs');
      await checkpoint();
    }
  };
  const enabled = async () => {
    const response = await fetch('https://reposhelf.vercel.app/api/editorial?action=x-status', {redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('Administrator scanning setting unavailable; no X search requested');
    const data=await response.json();
    if (typeof data.enabled!=='boolean'||typeof data.ready!=='boolean') throw Error('Invalid scanning setting; no X search requested');
    return data.ready && data.enabled;
  };
  const report = await collect({config, state, request, save, enabled});
  console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
