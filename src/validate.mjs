import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve, join} from 'node:path';
import {mkdir, copyFile, access, writeFile} from 'node:fs/promises';
import {initialState, dueCandidates, iso, sourceCategory, queryKey} from './core.mjs';
import {readJson, saveJson} from './io.mjs';
import {runConfig} from './search-plan.mjs';
import {resolveDemoSeeds,associatedDemo} from './demo-discovery.mjs';

export async function validateCandidates({state, config, importEntry, qualify, eligible, existing = new Set(), save, now = Date.now}) {
  let checked = 0;
  for (const candidate of dueCandidates(state, now()).slice(0, config.maxRepositoriesPerRun)) {
    if (existing.has(candidate.full.toLowerCase()) && candidate.status !== 'accepted') { candidate.status = 'known'; candidate.reason = 'already_in_reposhelf'; continue; }
    checked++;
    if(candidate.query){const stats=(state.queryStats||={})[queryKey(candidate.query)]||={query:candidate.query,posts:0,uniquePosts:0,newCandidates:0};stats.validationAttempts=(stats.validationAttempts||0)+1;}
    try {
      const entry = await importEntry(candidate);
      if (!entry?.demo) { candidate.status = 'retry'; candidate.reason = 'no_hosted_demo'; candidate.nextAttemptAt = iso(now() + 7 * 86400000); continue; }
      candidate.full = entry.full;
      const result = await qualify(entry);
      candidate.entry = result.entry;
      candidate.status = result.details.status;
      candidate.reason = result.details.reason || null;
      candidate.nextAttemptAt = result.details.status === 'accepted' ? iso(now() + 36 * 3600000) : result.details.nextAttemptAt || iso(now() + 6 * 3600000);
      candidate.checkedAt = iso(now());
      if(candidate.query&&candidate.status==='accepted'&&!candidate.firstAcceptedAt){candidate.firstAcceptedAt=iso(now());const stats=state.queryStats[queryKey(candidate.query)];stats.accepted=(stats.accepted||0)+1;}
    } catch (error) {
      candidate.status = [404, 410].includes(error.status) ? 'rejected' : 'retry';
      candidate.reason = [404, 410].includes(error.status) ? 'repository_unavailable' : 'temporary_error';
      candidate.nextAttemptAt = iso(now() + 6 * 3600000);
      if ([403, 429].includes(error.status)) { await save(state); break; }
    }
    await save(state);
  }
  const accepted = new Map();
  for (const candidate of Object.values(state.candidates)) {
    if (candidate.status !== 'accepted' || !candidate.entry || !eligible(candidate.entry, now())) continue;
    const key = candidate.entry.full.toLowerCase();
    const entry = accepted.get(key) || {...candidate.entry, discoveredVia: []};
    for (const source of candidate.sources) if (!entry.discoveredVia.some(s => s.url === source.url)) entry.discoveredVia.push(source);
    entry.sourceCategories = [...new Set([...(entry.sourceCategories || []), sourceCategory])];
    accepted.set(key, entry);
  }
  await save(state);
  return {schema: 1, updatedAt: iso(now()), runtimeRevision: config.repoShelfRevision, checked, repositories: [...accepted.values()]};
}

async function main() {
  const config = runConfig(await readJson('config.json'),process.env.COLLECTOR_POST_LIMIT);
  const state = await readJson('state/state.json', initialState());
  const runtime = resolve(process.env.REPOSHELF_ROOT || 'runtime');
  const runtimeRequire = createRequire(join(runtime, 'package.json'));
  const D = runtimeRequire('./dist/discovery.js'), Q = runtimeRequire('./dist/quality.js'), T = runtimeRequire('./dist/taxonomy.js');
  const {createSubmissionQualifier} = await import(pathToFileURL(join(runtime, 'scripts/submission-quality.mjs')));
  const artifactsRoot = pathToFileURL(resolve('artifacts') + '/');
  const controlsResponse = await fetch('https://reposhelf.vercel.app/api/editorial?action=controls', {signal: AbortSignal.timeout(15000)});
  if (!controlsResponse.ok) throw Error('Live moderation controls unavailable; validation stopped');
  const controls = await controlsResponse.json();
  if (controls.ready === false || !Array.isArray(controls.items) || controls.items.some(c => !/^(hf:)?[\w.-]+\/[\w.-]+$/.test(c.project_id) || !['visible', 'hidden', 'excluded'].includes(c.visibility))) throw Error('Live moderation controls are not ready');
  const excluded = new Set(controls.items.filter(c => ['hidden', 'excluded'].includes(c.visibility)).map(c => c.project_id.toLowerCase()));
  const headers = {Accept: 'application/vnd.github+json', 'User-Agent': 'RepoShelf-X-Collector', ...(process.env.GITHUB_TOKEN ? {Authorization: 'Bearer ' + process.env.GITHUB_TOKEN} : {})};
  async function github(path) {
    const response = await fetch('https://api.github.com' + path, {headers, signal: AbortSignal.timeout(15000), redirect: 'error'});
    if (!response.ok) throw Object.assign(Error('GitHub HTTP ' + response.status), {status: response.status});
    return response;
  }
  const {applyListingControls} = await import(pathToFileURL(join(runtime, 'lib/listing-policy.mjs')));
  const probeQualifier = createSubmissionQualifier({root: artifactsRoot, controls: async () => controls.items});
  const {publicUrlGuard}=await import(pathToFileURL(join(runtime,'scripts/demo-health.mjs')));
  await resolveDemoSeeds({state,config,guard:publicUrlGuard(),save:data=>saveJson('state/state.json',data)});
  const importEntry = async candidate => {
    if (excluded.has(candidate.full.toLowerCase())) throw Object.assign(Error('Moderated repository'), {status: 404});
    if(!excluded.has(candidate.full.toLowerCase())){try{const response=await fetch('https://www.reposhelf.co.uk/api/editorial?action=detail&id='+encodeURIComponent(candidate.full),{signal:AbortSignal.timeout(15000),redirect:'error'});if(response.ok){const current=await response.json(),entry=current.repo;if(entry&&entry.full?.toLowerCase()===candidate.full.toLowerCase()&&Q.publishedEligible(entry)&&!entry.demoHealth?.error){candidate.reusedEvidence=true;return {...entry,discoveredVia:candidate.sources};}}}catch{}}
    const d = await (await github('/repos/' + candidate.full)).json();
    if (d.private !== false || d.visibility && d.visibility !== 'public' || !D.mapRepo || !/^[\w.-]+\/[\w.-]+$/.test(d.full_name)) throw Object.assign(Error('Repository not public'), {status: 404});
    if (excluded.has(d.full_name.toLowerCase())) throw Object.assign(Error('Moderated repository'), {status: 404});
    let markdown = '';
    try {
      const readme = await (await github('/repos/' + d.full_name + '/readme')).json();
      if (readme.encoding !== 'base64' || readme.size > 2 * 1024 * 1024) throw Error('README too large or unsupported');
      markdown = Buffer.from(readme.content, 'base64').toString('utf8');
    } catch (e) { if (e.status !== 404) throw e; }
    const mapped = D.mapRepo(d), demo = D.extractDemo(markdown, d.homepage)||associatedDemo(candidate,d,markdown,D.demoUrl), at = iso(Date.now());
    const prior = candidate.entry?.demo === demo ? candidate.entry : {};
    return T.annotate({...prior, ...mapped, demo, lastCheckedAt: at, lastAvailableAt: at, lastAttemptAt: at, demoEvidence: candidate.demoEvidence, discoveredVia: candidate.sources});
  };
  const candidateReuse=entry=>Object.values(state.candidates).some(c=>c.full.toLowerCase()===entry.full.toLowerCase()&&c.reusedEvidence);
  const qualify = async entry => {
    if (Q.publishedEligible(entry) && !entry.demoHealth?.error) {
      const image = entry.screenshots?.find(s => s.kind === 'demo' && /^previews\/[a-f0-9]{24}\.jpg$/.test(s.src));
      if (image) { try { await access(join('state', image.src)); return {entry, details: {status: 'accepted'}}; } catch {}
       if(candidateReuse(entry)){try{const r=await fetch('https://www.reposhelf.co.uk/'+image.src,{redirect:'error',signal:AbortSignal.timeout(15000)});if(r.ok&&/image\/jpeg/.test(r.headers.get('content-type')||'')){const bytes=await limitedBytes(r,2*1024*1024);if(bytes[0]===255&&bytes[1]===216){await mkdir('state/previews',{recursive:true});await writeFile(join('state',image.src),bytes);return {entry,details:{status:'accepted'}};}}}catch{}} }
    }
    const result = await probeQualifier(entry);
    if (result.details.status === 'accepted') {
      await mkdir('state/previews', {recursive: true});
      for (const image of result.entry.screenshots.filter(s => s.kind === 'demo' && /^previews\/[a-f0-9]{24}\.jpg$/.test(s.src))) await copyFile(join('artifacts/dist', image.src), join('state', image.src));
    }
    return result;
  };
  const eligible = (entry, now) => {
    const allowed = applyListingControls([entry], controls.items);
    return allowed.length > 0 && Q.publishedEligible(allowed[0], now);
  };
  const output = await validateCandidates({state, config, importEntry, qualify, eligible, save: data => saveJson('state/state.json', data)});
  await saveJson('state/approved.json', output);

  const markdown = ['# RepoShelf candidates from X', '', `Checked: ${output.updatedAt}`, '', `Quality-ready repositories: **${output.repositories.length}**`, '', '## Search yield', '', '| Query | Posts read | Unique posts | New repos | First accepted |', '| --- | ---: | ---: | ---: | ---: |', ...Object.values(state.queryStats||{}).map(s=>`| ${s.query.replaceAll('|',' ')} | ${s.posts||0} | ${s.uniquePosts||0} | ${s.newCandidates||0} | ${s.accepted||0} |`), '', 'Acceptance totals are attributed to the first discovery query; these are not controlled experiments.', '', '| Repository | Demo | Screenshot | Source post |', '| --- | --- | --- | --- |', ...output.repositories.map(r => `| [${r.full}](https://github.com/${r.full}) | [Try demo](${r.demo}) | [Screenshot](${r.screenshots.find(s => s.kind === 'demo').src}) | [Source](${r.discoveredVia[0].url}) |`), '', 'Checks expire: repositories after 48 hours; demos after seven days. RepoShelf applies current moderation before publication.', ''].join('\n');
  await writeFile('state/report.md', markdown);
  console.log('Quality-ready repositories: ' + output.repositories.length + '. Checked this run: ' + output.checked + '.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });

async function limitedBytes(response,limit){let total=0;const chunks=[];for await(const chunk of response.body){total+=chunk.length;if(total>limit)throw Error('Screenshot too large');chunks.push(chunk)}return Buffer.concat(chunks);}
