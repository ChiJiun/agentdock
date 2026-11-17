import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { ensureInside } from './adapters.mjs';

const REPO = /^[a-zA-Z0-9_.-]{1,100}$/;
const GH_TIMEOUT = 9000;
const MAX_BUFFER = 256_000;
function safeGithubLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch { return null; }
}

export function parseGithubRemote(remote) {
  if (typeof remote !== 'string' || remote.length > 600) return null;
  let name = '';
  if (remote.startsWith('https://github.com/')) name = remote.slice('https://github.com/'.length);
  else if (remote.startsWith('git@github.com:')) name = remote.slice('git@github.com:'.length);
  else if (remote.startsWith('ssh://git@github.com/')) name = remote.slice('ssh://git@github.com/'.length);
  else return null;
  name = name.replace(/\.git$/, '').replace(/\/$/,'');
  const [owner,repo,...extra]=name.split('/');
  if (extra.length || !REPO.test(owner||'') || !REPO.test(repo||'')) return null;
  if (owner === '.' || repo === '.' || owner === '..' || repo === '..') return null;
  return { owner, repo, fullName: owner + '/' + repo };
}

/**
 * Read-only GitHub evidence via the operator's already authenticated GitHub CLI.
 * Only a GitHub remote of a locally approved repository may be requested.
 * There is intentionally no write, merge, push or review-post API.
 */
export class GitHubReader {
  constructor({ roots, ghBin = process.env.AGENTDOCK_GH_BINARY || 'gh', exec = execFileSync }) {
    this.roots = roots;
    this.ghBin = ghBin;
    this.exec = exec;
  }
  run(program, args, cwd) {
    try {
      return this.exec(program, args, {
        cwd, encoding:'utf8',timeout:GH_TIMEOUT,maxBuffer:MAX_BUFFER,windowsHide:true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
      }).trim();
    } catch {
      // Never surface gh stderr; it may expose config, paths or credentials.
      throw new Error('read-only GitHub CLI request failed (check gh login and repository permissions)');
    }
  }
  identify(candidate) {
    const cwd = ensureInside(candidate, this.roots);
    const root = realpathSync(this.run('git',['-C',cwd,'rev-parse','--show-toplevel'],cwd));
    ensureInside(root,this.roots);
    const remote = this.run('git',['-C',root,'config','--get','remote.origin.url'],root);
    const identity = parseGithubRemote(remote);
    if (!identity) throw new Error('this workspace has no supported github.com origin');
    return { ...identity, root };
  }
  fetchJson(path, root) {
    const result = this.run(this.ghBin,['api','-H','Accept: application/vnd.github+json',path],root);
    try { return JSON.parse(result); }
    catch { throw new Error('GitHub CLI returned invalid JSON'); }
  }
  issues(candidate) {
    const repo = this.identify(candidate);
    const rows = this.fetchJson(`repos/${repo.fullName}/issues?state=open&per_page=30`,repo.root);
    if (!Array.isArray(rows)) throw new Error('Unexpected GitHub response');
    return {
      repo: repo.fullName,
      items: rows.filter(x=>!x.pull_request).slice(0,30).map(x=>({
        number:x.number,title:String(x.title).slice(0,200),url:safeGithubLink(x.html_url),state:x.state,
      })),
    };
  }
  pulls(candidate) {
    const repo = this.identify(candidate);
    const rows = this.fetchJson(`repos/${repo.fullName}/pulls?state=open&per_page=30`,repo.root);
    if (!Array.isArray(rows)) throw new Error('Unexpected GitHub response');
    return {
      repo: repo.fullName,
      items: rows.slice(0,30).map(x=>({
        number:x.number,title:String(x.title).slice(0,200),url:safeGithubLink(x.html_url),
        state:x.draft?'draft':x.state,headSha:String(x.head?.sha||'').slice(0,40),
      })),
    };
  }
  checks(candidate, sha) {
    const repo = this.identify(candidate);
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid commit SHA');
    const row = this.fetchJson(`repos/${repo.fullName}/commits/${sha}/check-runs?per_page=30`,repo.root);
    if (!Array.isArray(row.check_runs)) throw new Error('Unexpected GitHub check response');
    return {
      repo: repo.fullName, sha,
      items: row.check_runs.map(x=>({
        id:x.id,name:String(x.name).slice(0,150),status:x.status,
        conclusion:x.conclusion,url:safeGithubLink(x.html_url),
      })),
    };
  }
}
