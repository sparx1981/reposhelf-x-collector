import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {initialState,addPosts,dueCandidates,queryState} from '../src/core.mjs';import {collect} from '../src/collect.mjs';import {runConfig,searchPlan} from '../src/search-plan.mjs';import {associatedDemo,resolveDemoSeeds} from '../src/demo-discovery.mjs';
const config=JSON.parse(await readFile(new URL('../config.json',import.meta.url))),time=Date.parse('2026-10-09T12:00Z');
test('one-run larger cap reserves at most $1; defaults unchanged; queries request long posts and engagement',async()=>{
 const large=runConfig(config,'100');assert.equal(config.maxPostsPerRun,50);assert.equal(large.maxRepositoriesPerRun,60);assert.throws(()=>runConfig(config,'500'));
 let count=0,requests=0;const state=initialState(time),saved=[];
 const result=await collect({config:large,state,now:()=>time,enabled:async()=>true,save:async s=>saved.push(s.reservedUsd),request:async path=>{
  if(path.includes('credits'))return {data:{free_balance:19.62,prepaid_balance:0,total_balance:19.62}};
  const u=new URL(path,'https://api.x.com'),max=Number(u.searchParams.get('max_results'));assert(max>=10&&max<=25);assert(saved.length);assert(saved.at(-1)<=1.000001);assert(u.searchParams.get('tweet.fields').includes('note_tweet'));assert(u.searchParams.get('tweet.fields').includes('public_metrics'));requests++;
  return {data:Array.from({length:max},()=>({id:String(++count),entities:{urls:[{expanded_url:'https://github.com/team/app'+count}]}})),meta:{next_token:'page'+requests}};
 }});assert.equal(result.postsRead,100);assert.equal(result.reservedUsd,1);assert.equal(result.queries.reduce((n,q)=>n+q.postsRead,0),100);assert.equal(result.queries[2].postsRead,30);
 const windows=queryState(state,searchPlan(config,initialState(time))[0].query,config,time);assert(Date.parse(windows.history.end)<Date.parse(windows.recent.start));
});
test('long post links retain source association; ambiguous multi-repository demos are omitted',()=>{
 const state=initialState(time);addPosts(state,[{id:'12',note_tweet:{text:'Try the demo https://github.com/team/app https://app.vercel.app'},public_metrics:{like_count:100},created_at:new Date(time).toISOString()}],'q',time);
 const c=state.candidates['team/app'];assert.equal(c.demoHints[0],'https://app.vercel.app/');assert.equal(associatedDemo(c,{full_name:'team/app'},'',x=>x),c.demoHints[0]);assert.equal(c.demoEvidence.postUrl,'https://x.com/i/web/status/12');
 addPosts(state,[{id:'13',text:'https://github.com/team/one https://github.com/team/two https://demo.netlify.app'}],'q',time);assert(!state.candidates['team/one'].demoHints);
 addPosts(state,[{id:'12',text:'https://github.com/team/app'}],'q',time);assert.equal(Object.values(state.queryStats)[0].uniquePosts,2);
 c.status='accepted';const next={full:'team/new',firstSeenAt:new Date(time).toISOString(),status:'queued',sources:[]};state.candidates['team/new']=next;assert.equal(dueCandidates(state,time)[0].status,'queued');assert(dueCandidates(state,time).indexOf(next)<dueCandidates(state,time).indexOf(c));
});
test('demo-first resolution refuses unsafe pages and ambiguous repository links',async()=>{
 const state=initialState(time);addPosts(state,[{id:'99',text:'Try this demo https://demo.netlify.app'}],'demo-first',time);
 let pages=0,closed=false;const fake={newContext:async()=>({route:async()=>{},newPage:async()=>{pages++;return {goto:async()=>({ok:()=>true}),locator:()=>({evaluateAll:async()=>['https://github.com/team/app']}),close:async()=>{}}}}),close:async()=>{closed=true}};
 const off=await resolveDemoSeeds({state,config,guard:async()=>false,save:async()=>{},browserFactory:async()=>fake,now:()=>time});assert.equal(off.resolved,0);assert.equal(pages,0);assert(closed);
 delete state.demoSeeds['https://demo.netlify.app/'].nextAttemptAt;
 const found=await resolveDemoSeeds({state,config,guard:async()=>true,save:async()=>{},browserFactory:async()=>fake,now:()=>time});assert.equal(found.resolved,1);assert.equal(state.candidates['team/app'].demoLinks[0].postUrl,'https://x.com/i/web/status/99');
});
