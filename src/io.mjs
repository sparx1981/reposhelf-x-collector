import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname} from 'node:path';
export async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; } }
export async function saveJson(file, data) { await mkdir(dirname(file), {recursive: true}); await writeFile(file + '.tmp', JSON.stringify(data, null, 2) + '\n'); await rename(file + '.tmp', file); }
