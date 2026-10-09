import {initialState, validateConfig, creditAllowance, addPosts, queryState, queryKey, iso} from './core.mjs';
import {searchPlan,runConfig} from './search-plan.mjs';
import {readJson, saveJson} from './io.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function collect({config,state,request,save,enabled=async()=>false,now=Date.now}){
 validateConfig(config);let read=0,reserved=0,stopped=null;const before=Object.keys(state.candidates).length,results=[];
 for(const task of searchPlan(config,state)){
  const progress=queryState(state,task.query,config,now()),cursor=progress[task.endpoint==='all'?'history':'recent'];
  if(task.endpoint==='all'&&cursor.done)continue;
  if(task.endpoint==='recent'){const lower=now()-7*86400000+60000;if(Date.parse(cursor.start)<lower){(state.coverageGaps||=[]).push({query:task.query,start:cursor.start,end:iso(lower)});cursor.start=iso(lower);delete cursor.nextToken;}if(!cursor.end)cursor.end=iso(now()-30000);}
  let requested=0;const initial=Object.keys(state.candidates).length;const result={query:task.query,endpoint:task.endpoint,postsRead:0,newCandidates:0};
  while(requested<task.limit&&read<config.maxPostsPerRun){
   if(!await enabled()){stopped='admin_disabled';break;}
   let balance;try{balance=await request('/2/usage/credits')}catch(e){if([402,403,429].includes(e.status)){stopped='x_api_http_'+e.status;break;}throw e;}
   const allowance=creditAllowance(balance,config,state,reserved,now());state.lastFreeBalanceUsd=allowance.freeBalanceUsd??null;state.lastTotalBalanceUsd=allowance.totalBalanceUsd??null;
   let max=Math.min(config.pageSize,task.limit-requested,config.maxPostsPerRun-read,allowance.posts);
   // Avoid an unusable final page smaller than X's ten-post minimum.
   if(task.limit-requested>config.pageSize&&task.limit-requested-config.pageSize<10)max=Math.min(max,task.limit-requested-10);
   if(max<10){if(allowance.posts<10)stopped=allowance.reason||'run_limit';break;}
   const usd=Math.round(max*config.conservativePostCostUsd*1e6)/1e6;state.reservedUsd=Math.round((state.reservedUsd+usd)*1e6)/1e6;state.requests++;reserved+=usd;requested+=max;
   await save(state,true);if(!await enabled()){stopped='admin_disabled';break;}
   const params=new URLSearchParams({query:task.query,max_results:String(max),start_time:cursor.start,end_time:cursor.end,'tweet.fields':'created_at,entities,note_tweet,public_metrics'});if(cursor.nextToken)params.set('next_token',cursor.nextToken);
   let response;try{response=await request('/2/tweets/search/'+task.endpoint+'?'+params)}catch(e){if([402,403,429].includes(e.status)){stopped='x_api_http_'+e.status;break;}throw e;}
   const posts=response.data||[];if(!Array.isArray(posts)||posts.length>max||response.errors?.length)throw Error('Search response is incomplete or invalid; cursor retained for retry');
   addPosts(state,posts,task.query,now());read+=posts.length;result.postsRead+=posts.length;
   if(response.meta?.next_token)cursor.nextToken=response.meta.next_token;else{delete cursor.nextToken;if(task.endpoint==='all')cursor.done=true;else{cursor.start=iso(Date.parse(cursor.end)-60000);delete cursor.end;}}
   await save(state,true);if(!response.meta?.next_token)break;
  }
  result.newCandidates=Object.keys(state.candidates).length-initial;results.push(result);if(stopped)break;
 }
 state.queryTurn++;state.lastRun={at:iso(now()),postsRead:read,reservedUsd:Math.round(reserved*1e6)/1e6,stopped,candidateCount:Object.keys(state.candidates).length,newCandidates:Object.keys(state.candidates).length-before,postLimit:config.maxPostsPerRun,queries:results};await save(state,true);return state.lastRun;
}
async function main() {
  const config = runConfig(await readJson('config.json'),process.env.COLLECTOR_POST_LIMIT);
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
