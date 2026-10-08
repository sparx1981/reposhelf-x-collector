import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initialState, creditAllowance, repoFromUrl, addPosts, safeSource} from '../src/core.mjs';
import {collect} from '../src/collect.mjs';
import {validateCandidates} from '../src/validate.mjs';
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
const time = Date.parse('2026-10-08T12:00:00Z');
const balance = free => ({data: {free_balance: free, prepaid_balance: 0, total_balance: free, free_grants: [{amount: free, expires_at: '2027-01-01T00:00:00Z'}]}});

test('account balance gate accepts paid credits and stops on unknown, depleted or negative balances', () => {
  const state=initialState(time);
  assert.equal(creditAllowance(balance(20),config,state,0,time).posts,50);
  const paid={data:{free_balance:0,prepaid_balance:20,total_balance:20,free_grants:[]}};
  assert.equal(creditAllowance(paid,config,state,0,time).posts,50);
  for(const input of [{},balance(0),balance(2),{...balance(20),errors:[{}]},{data:{...paid.data,prepaid_balance:-0.01}}])assert.equal(creditAllowance(input,config,state,0,time).posts,0);
  state.reservedUsd=100;
  assert.equal(creditAllowance(paid,config,state,0,time).posts,50,'Adding balance can support future runs without resetting state');
  assert.equal(creditAllowance(paid,config,state,0.45,time).reason,'credit_reserve_reached');
});

test('extracts expanded GitHub links and deduplicates repos and source posts', () => {
  const state = initialState(time), post = {id: '123456', text: '', entities: {urls: [{expanded_url: 'https://github.com/Team/App/tree/main'}, {unwound_url: 'https://github.com/team/app'}]}};
  addPosts(state, [post, post], 'query', time);
  assert.equal(Object.keys(state.candidates).length, 1);
  assert.equal(state.candidates['team/app'].sources.length, 1);
  assert.equal(repoFromUrl('https://github.com/topics/react'), null);
  assert.equal(repoFromUrl('https://github.com.evil.test/team/app'), null);
  assert.equal(repoFromUrl('https://user:pass@github.com/team/app'), null);
  assert.equal(repoFromUrl('https://github.com/team/app.git'), 'team/app');
  assert(safeSource(state.candidates['team/app'].sources[0].url));
});

test('admin disable stops all X requests, including manual collection and the next page', async () => {
  let requests=0;
  const off=await collect({config,state:initialState(time),request:async()=>{requests++;return balance(20);},save:async()=>{},now:()=>time});
  assert.equal(requests,0);assert.equal(off.stopped,'admin_disabled');
  let searches=0;
  const result=await collect({config,state:initialState(time),enabled:async()=>searches===0,request:async path=>{if(path.includes('credits'))return balance(20);searches++;return {data:[],meta:{}};},save:async()=>{},now:()=>time});
  assert.equal(searches,1);assert.equal(result.stopped,'admin_disabled');
  requests=0;
  await assert.rejects(collect({config,state:initialState(time),enabled:async()=>{throw Error('setting unavailable');},request:async()=>{requests++;},save:async()=>{},now:()=>time}),/setting unavailable/);
  assert.equal(requests,0);
});

test('billing rejection stops without a retry or losing the durable reservation', async () => {
  let searches=0;
  const state=initialState(time);
  const result=await collect({config,state,enabled:async()=>true,request:async path=>{if(path.includes('credits'))return balance(20);searches++;throw Object.assign(Error('No credit'),{status:402});},save:async()=>{},now:()=>time});
  assert.equal(searches,1);assert.equal(result.stopped,'x_api_http_402');assert.equal(state.reservedUsd,0.25);
});
test('reserves credits durably before search; resumes historical pagination', async () => {
  const state = initialState(time), saved = [], search = [];
  const request = async path => {
    if (path.includes('usage/credits')) return balance(20);
    assert(saved.length, 'Metered call requires a prior save');
    assert(state.reservedUsd >= 0.25);
    search.push(new URL(path, 'https://api.x.com'));
    return {data: [{id: String(search.length), entities: {urls: [{expanded_url: 'https://github.com/team/app'}]}}], meta: {next_token: 'next' + search.length}};
  };
  await collect({enabled:async()=>true, config, state, request, save: async s => saved.push(structuredClone(s)), now: () => time});
  assert.equal(search.length, 2);
  assert.equal(state.reservedUsd, 0.5);
  assert.equal(search[1].pathname, '/2/tweets/search/all');
  assert.equal(search[1].searchParams.get('start_time'), '2026-07-10T12:00:00.000Z');
  assert.equal(search[1].searchParams.has('expansions'), false);
  state.queryTurn = 0;
  await collect({enabled:async()=>true, config, state, request, save: async s => saved.push(structuredClone(s)), now: () => time + 86400000});
  assert.equal(search[3].searchParams.get('next_token'), 'next2');
  assert.equal(search[3].searchParams.get('end_time'), search[1].searchParams.get('end_time'));
});
test('a failed checkpoint prevents any metered request; timeout retains reservation', async () => {
  let searches = 0;
  const request = async path => { if (path.includes('credits')) return balance(20); searches++; throw Error('timeout'); };
  await assert.rejects(collect({enabled:async()=>true, config, state: initialState(time), request, save: async () => { throw Error('push failed'); }, now: () => time}), /push failed/);
  assert.equal(searches, 0);
  const state = initialState(time);
  await assert.rejects(collect({enabled:async()=>true, config, state, request, save: async () => {}, now: () => time}), /timeout/);
  assert.equal(state.reservedUsd, 0.25);
  assert.equal(searches, 1);
});
test('validation only exports accepted fresh entries and merges canonical aliases', async () => {
  const state = initialState(time);
  addPosts(state, [{id: '123', text: 'https://github.com/team/one https://github.com/team/two https://github.com/team/login'}], 'q', time);
  const output = await validateCandidates({state, config, now: () => time, save: async () => {}, importEntry: async c => ({full: c.full.includes('login') ? c.full : 'team/canonical', demo: 'https://demo.test'}), qualify: async entry => ({entry, details: {status: entry.full.includes('login') ? 'retry' : 'accepted'}}), eligible: () => true});
  assert.equal(output.repositories.length, 1);
  assert.equal(output.repositories[0].full, 'team/canonical');
  assert.deepEqual(output.repositories[0].sourceCategories, ['As Seen On X.com']);
  const stale = await validateCandidates({state, config, now: () => time, save: async () => {}, importEntry: async () => { throw Error('unexpected refresh'); }, qualify: async () => {}, eligible: () => false});
  assert.equal(stale.repositories.length, 0);
});
