import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { ensureInside } from './adapters.mjs';

const REPO = /^[a-zA-Z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
const PAGE = 30;
// Network-bound: on a congested link single responses took 30-100 s in local measurements, so
// the request runs asynchronously (never blocking the ACP event loop) with a bounded timeout.
const GH_TIMEOUT = 60_000;
const GIT_TIMEOUT = 15_000;
// Issue/PR list responses include full bodies and repository objects; 30 open PRs measured
// at roughly 20 KB each, so a 256 KB cap failed on a real repository. Keep a hard upper bound.
const MAX_BUFFER = 8 * 1024 * 1024;
// Strip variables that could redirect `gh` to another host or repository than the parsed origin.
const STRIPPED_ENV = ['GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

/** Errors whose message is safe to show the operator (never contains gh stderr or tokens). */
export class GitHubEvidenceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeGithubLink(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.toString() : null;
  } catch { return null; }
}
const text = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
const word = value => (typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null);

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

function execFileAsync(program, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(program, args, options, (error, stdout) => (error ? rejectRun(error) : resolveRun(stdout)));
  });
}

/**
 * Read-only GitHub evidence via the operator's already authenticated GitHub CLI.
 * Only a GitHub remote of a locally approved repository may be requested.
 * There is intentionally no write, merge, push or review-post API: every `gh` call is
 * `gh api --method GET --hostname github.com <fixed path>`.
 */
export class GitHubReader {
  constructor({ roots, ghBin = process.env.AGENTDOCK_GH_BINARY || 'gh', exec = execFileAsync, ghTimeout = GH_TIMEOUT }) {
    this.roots = roots;
    this.ghTimeout = ghTimeout;
    this.ghBin = ghBin;
    this.exec = exec;
  }
  async run(program, args, cwd, timeout) {
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1' };
    for (const key of STRIPPED_ENV) delete env[key];
    try {
      const output = await this.exec(program, args, {
        cwd, encoding:'utf8', timeout, maxBuffer:MAX_BUFFER, windowsHide:true, env,
      });
      return String(output).trim();
    } catch {
      // Never surface gh stderr; it may expose config, paths or credentials.
      throw new GitHubEvidenceError(502, 'read-only GitHub CLI request failed (check gh login, network and repository permissions)');
    }
  }
  async identify(candidate) {
    const cwd = ensureInside(candidate, this.roots);
    const root = realpathSync(await this.run('git',['-C',cwd,'rev-parse','--show-toplevel'],cwd,GIT_TIMEOUT));
    ensureInside(root,this.roots);
    const remote = await this.run('git',['-C',root,'config','--get','remote.origin.url'],root,GIT_TIMEOUT);
    const identity = parseGithubRemote(remote);
    if (!identity) throw new GitHubEvidenceError(400, 'this workspace has no supported github.com origin');
    return { ...identity, root };
  }
  async fetchJson(path, root) {
    const result = await this.run(this.ghBin,[
      'api','--method','GET','--hostname','github.com','-H','Accept: application/vnd.github+json',path,
    ],root,this.ghTimeout);
    try { return JSON.parse(result); }
    catch { throw new GitHubEvidenceError(502, 'GitHub CLI returned invalid JSON'); }
  }
  async issues(candidate) {
    const repo = await this.identify(candidate);
    const rows = await this.fetchJson(`repos/${repo.fullName}/issues?state=open&per_page=${PAGE}`,repo.root);
    if (!Array.isArray(rows)) throw new GitHubEvidenceError(502, 'Unexpected GitHub response');
    return {
      repo: repo.fullName,
      // The Issues endpoint also returns PRs; a full page means more results may exist.
      truncated: rows.length >= PAGE,
      items: rows.filter(x=>!x.pull_request).slice(0,PAGE).map(x=>({
        number:Number(x.number),title:text(x.title,200),url:safeGithubLink(x.html_url),state:word(x.state)??'unknown',
      })),
    };
  }
  async pulls(candidate) {
    const repo = await this.identify(candidate);
    const rows = await this.fetchJson(`repos/${repo.fullName}/pulls?state=open&per_page=${PAGE}`,repo.root);
    if (!Array.isArray(rows)) throw new GitHubEvidenceError(502, 'Unexpected GitHub response');
    return {
      repo: repo.fullName,
      truncated: rows.length >= PAGE,
      items: rows.slice(0,PAGE).map(x=>{
        const headSha = String(x.head?.sha||'');
        return {
          number:Number(x.number),title:text(x.title,200),url:safeGithubLink(x.html_url),
          state:x.draft?'draft':(word(x.state)??'unknown'),headSha:SHA.test(headSha)?headSha:'',
        };
      }),
    };
  }
  async checks(candidate, sha) {
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new GitHubEvidenceError(400, 'invalid commit SHA');
    const repo = await this.identify(candidate);
    const row = await this.fetchJson(`repos/${repo.fullName}/commits/${sha}/check-runs?per_page=${PAGE}`,repo.root);
    if (!row || !Array.isArray(row.check_runs)) throw new GitHubEvidenceError(502, 'Unexpected GitHub check response');
    const total = Number.isInteger(row.total_count) ? row.total_count : row.check_runs.length;
    return {
      repo: repo.fullName, sha, total,
      truncated: total > row.check_runs.length,
      items: row.check_runs.slice(0,PAGE).map(x=>({
        id:Number(x.id),name:text(x.name,150),status:word(x.status)??'unknown',
        conclusion:word(x.conclusion),url:safeGithubLink(x.html_url),
      })),
    };
  }
}
