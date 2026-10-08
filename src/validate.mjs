import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve, join} from 'node:path';
import {mkdir, copyFile, access} from 'node:fs/promises';
import {initialState, dueCandidates, iso, sourceCategory} from './core.mjs';
import {readJson, saveJson} from './io.mjs';

export async function validateCandidates({state, config, importEntry, qualify, eligible, existing = new Set(), save, now = Date.now}) {
  let checked = 0;
  for (const candidate of dueCandidates(state, now()).slice(0, config.maxRepositoriesPerRun)) {
    if (existing.has(candidate.full.toLowerCase()) && candidate.status !== 'accepted') { candidate.status = 'known'; candidate.reason = 'already_in_reposhelf'; continue; }
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
      checked++;
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
  const config = await readJson('config.json');
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
  const importEntry = async candidate => {
    if (excluded.has(candidate.full.toLowerCase())) throw Object.assign(Error('Moderated repository'), {status: 404});
    const d = await (await github('/repos/' + candidate.full)).json();
    if (d.private !== false || d.visibility && d.visibility !== 'public' || !D.mapRepo || !/^[\w.-]+\/[\w.-]+$/.test(d.full_name)) throw Object.assign(Error('Repository not public'), {status: 404});
    if (excluded.has(d.full_name.toLowerCase())) throw Object.assign(Error('Moderated repository'), {status: 404});
    let markdown = '';
    try {
      const readme = await (await github('/repos/' + d.full_name + '/readme')).json();
      if (readme.encoding !== 'base64' || readme.size > 2 * 1024 * 1024) throw Error('README too large or unsupported');
      markdown = Buffer.from(readme.content, 'base64').toString('utf8');
    } catch (e) { if (e.status !== 404) throw e; }
    const mapped = D.mapRepo(d), demo = D.extractDemo(markdown, d.homepage), at = iso(Date.now());
    const prior = candidate.entry?.demo === demo ? candidate.entry : {};
    return T.annotate({...prior, ...mapped, demo, lastCheckedAt: at, lastAvailableAt: at, lastAttemptAt: at, discoveredVia: candidate.sources});
  };
  const qualify = async entry => {
    if (Q.publishedEligible(entry) && !entry.demoHealth?.error) {
      const image = entry.screenshots?.find(s => s.kind === 'demo' && /^previews\/[a-f0-9]{24}\.jpg$/.test(s.src));
      if (image) { try { await access(join('state', image.src)); return {entry, details: {status: 'accepted'}}; } catch {} }
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
  const {writeFile} = await import('node:fs/promises');
  const markdown = ['# RepoShelf candidates from X', '', `Checked: ${output.updatedAt}`, '', `Quality-ready repositories: **${output.repositories.length}**`, '', '| Repository | Demo | Screenshot | Source post |', '| --- | --- | --- | --- |', ...output.repositories.map(r => `| [${r.full}](https://github.com/${r.full}) | [Try demo](${r.demo}) | [Screenshot](${r.screenshots.find(s => s.kind === 'demo').src}) | [Source](${r.discoveredVia[0].url}) |`), '', 'Checks expire: repositories after 48 hours; demos after seven days. RepoShelf applies current moderation before publication.', ''].join('\n');
  await writeFile('state/report.md', markdown);
  console.log('Quality-ready repositories: ' + output.repositories.length + '. Checked this run: ' + output.checked + '.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
