import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {initialState} from './core.mjs';
import {saveJson} from './io.mjs';
const branch = 'collector-state';
const git = (args, options = {}) => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options});
const safe = path => /^(?:state\.json|approved\.json|report\.md|previews\/[a-f0-9]{24}\.jpg)$/.test(path);
export async function restore() {
  await mkdir('state', {recursive: true});
  const refs = git(['ls-remote', '--heads', 'origin', branch]).trim();
  if (!refs) { await saveJson('state/state.json', initialState()); return; }
  git(['fetch', '--quiet', 'origin', branch]);
  const paths = git(['ls-tree', '-r', '--name-only', 'FETCH_HEAD']).trim().split('\n').filter(Boolean);
  for (const path of paths) {
    if (!safe(path)) throw Error('Unrecognised checkpoint path');
    const file = join('state', path); await mkdir(dirname(file), {recursive: true});
    await writeFile(file, git(['show', 'FETCH_HEAD:' + path], {encoding: null}));
  }
}
async function files(dir, prefix = '') {
  let out = [];
  for (const item of await readdir(dir, {withFileTypes: true})) {
    const path = prefix + item.name;
    if (item.isDirectory()) out.push(...await files(join(dir, item.name), path + '/'));
    else if (item.isFile() && safe(path)) out.push(path);
  }
  return out;
}
export async function checkpoint() {
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  const refs = git(['ls-remote', '--heads', 'origin', branch]).trim();
  let parent;
  if (refs) { git(['fetch', '--quiet', 'origin', branch]); parent = git(['rev-parse', 'FETCH_HEAD']).trim(); }
  const temp = await mkdtemp(join(tmpdir(), 'collector-index-'));
  try {
    const env = {...process.env, GIT_INDEX_FILE: join(temp, 'index')};
    git(['read-tree', '--empty'], {env});
    for (const path of await files('state')) {
      const bytes = await readFile(join('state', path));
      const sha = git(['hash-object', '-w', '--stdin'], {input: bytes}).trim();
      git(['update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + path], {env});
    }
    const tree = git(['write-tree'], {env}).trim();
    const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Save collector progress'];
    const commit = git(args).trim();
    // Never force-push. A competing update fails before another X request can start.
    git(['push', '--quiet', 'origin', commit + ':refs/heads/' + branch]);
  } finally { await rm(temp, {recursive: true, force: true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2];
  if (!['restore', 'save'].includes(action)) throw Error('Use restore or save');
  await (action === 'restore' ? restore() : checkpoint());
}
