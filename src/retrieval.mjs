import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chown, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const YT_DLP_VERSION = '2026.10.26';
export const YT_DLP_SHA256 = 'e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3';
const CAPTION_LIMIT = 2_000_000;

export function parseCaptions(content) {
  if (Buffer.byteLength(content) > CAPTION_LIMIT) throw new Error('Captions exceed 2 MB');
  const data = JSON.parse(content);
  if (!Array.isArray(data.events)) throw new Error('Invalid JSON3 captions');
  const lines = [];
  for (const event of data.events) {
    const line = (event.segs ?? []).map(segment => {
      if (typeof segment.utf8 !== 'string') throw new Error('Invalid caption segment');
      return segment.utf8;
    }).join('').replace(/\s+/g, ' ').trim();
    if (line && lines.at(-1) !== line) lines.push(line);
  }
  return lines.join('\n');
}

export function retrievalArgs({ id, image, artifact, scratch, name, user = '1000:1000' }) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid video ID');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Expected inspected image digest');
  if (!/^[1-9]\d*:[1-9]\d*$/.test(user)) throw new Error('Expected non-root numeric UID:GID');
  if ([artifact, scratch].some(value => !path.isAbsolute(value) || value.includes(','))) throw new Error('Mount paths must be absolute and contain no commas');
  return ['run', '--rm', '--pull', 'never', '--name', name, '--user', user,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--ulimit', 'fsize=2097152:2097152',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--env', 'HOME=/tmp',
    '--mount', `type=bind,source=${artifact},target=/runtime/yt-dlp,readonly`,
    '--mount', `type=bind,source=${scratch},target=/output`,
    '--workdir', '/output', '--entrypoint', '/usr/bin/python3', image,
    '/runtime/yt-dlp', '--ignore-config', '--no-plugin-dirs', '--no-remote-components',
    '--no-cache-dir', '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', 'en-orig,en', '--sub-format', 'json3', '--extractor-args', 'youtube:skip=translated_subs', '--js-runtimes', 'node:/usr/local/bin/node',
    '--paths', '/output', '--output', 'captions.%(ext)s', '--socket-timeout', '15',
    '--retries', '1', '--extractor-retries', '1', '--retry-sleep', '3', '--max-filesize', '2M',
    '--', `https://www.youtube.com/watch?v=${id}`];
}

function docker(args, { timeout = 180_000, outputLimit = 256_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const timer = setTimeout(() => { failure = new Error('yt-dlp container timed out'); child.kill(); }, timeout);
    for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
      stream.setEncoding('utf8');
      stream.on('data', value => {
        size += Buffer.byteLength(value);
        if (size > outputLimit) { failure = new Error('Container output exceeded limit'); child.kill(); }
        else append(value);
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
  });
}

export async function retrieveTranscript(id, { artifact, image = process.env.AUDITOR_RETRIEVAL_IMAGE } = {}) {
  let scratch, name;
  try {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Invalid video ID');
    if (!image || image.startsWith('-')) throw new Error('Set AUDITOR_RETRIEVAL_IMAGE to an existing reviewed Linux image with Python 3.11+ and Node.js');
    artifact = await realpath(artifact);
    if (!(await lstat(artifact)).isFile()) throw new Error('yt-dlp artifact must be a file');
    if (createHash('sha256').update(await readFile(artifact)).digest('hex') !== YT_DLP_SHA256) throw new Error('yt-dlp artifact digest mismatch');
    const inspected = await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 15_000 });
    if (inspected.code !== 0) throw new Error('Reviewed retrieval image is not available locally; no image was downloaded');
    scratch = await mkdtemp(path.join(os.tmpdir(), 'auditor-captions-'));
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const user = uid !== 0 ? `${uid}:${gid || 1000}` : '1000:1000';
    if (process.platform !== 'win32' && uid === 0) await chown(scratch, 1000, 1000);
    name = `auditor-captions-${randomUUID()}`;
    const result = await docker(retrievalArgs({ id, image: inspected.stdout.trim(), artifact, scratch, name, user }));
    if (result.code !== 0) {
      const message = (result.stderr || result.stdout).trim().slice(-3000);
      if (/\b429\b|Too Many Requests/i.test(message)) return { state: 'blocked', reason: 'YouTube rate limited yt-dlp with HTTP 429. Retry after the cooldown; no cookies were used.', retryAfter: new Date(Date.now() + 15 * 60_000).toISOString() };
      throw new Error(`yt-dlp failed: ${message}`);
    }
    const files = (await readdir(scratch)).filter(file => /^captions\.en(?:-orig)?\.json3$/.test(file)).sort((a, b) => Number(b.includes('en-orig')) - Number(a.includes('en-orig')));
    if (!files.length) return { state: 'blocked', reason: 'yt-dlp returned no usable English captions' };
    const file = path.join(scratch, files[0]);
    const info = await lstat(file);
    if (!info.isFile() || info.size > CAPTION_LIMIT) throw new Error('Invalid or oversized caption file');
    const transcript = parseCaptions(await readFile(file, 'utf8'));
    if (!transcript.trim()) return { state: 'blocked', reason: 'yt-dlp returned empty English captions' };
    return { state: 'ready', transcript };
  } catch (error) {
    return { state: 'failed', reason: error.message.replace(/<!--/g, '').slice(0, 4000) };
  } finally {
    if (name) {
      const cleanup = await docker(['rm', '-f', name], { timeout: 15_000 }).catch(error => ({ code: -1, stderr: error.message }));
      if (cleanup.code !== 0 && !/No such container/.test(cleanup.stderr)) {
        throw new Error(`Could not confirm retrieval container cleanup: ${name}. ${cleanup.stderr}`);
      }
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
