import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { childEnvironment, ensureInside } from './adapters.mjs';

const REPO = /^[a-zA-Z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
const PAGE = 30;
const API_PAGE = 100;
const MAX_PAGES = 5; // Explicit upper bound; incomplete evidence is never promoted to success.
// Network-bound: on a congested link single responses took 30-100 s in local measurements, so
// the request runs asynchronously (never blocking the ACP event loop) with a bounded timeout.
const GH_TIMEOUT = 60_000;
const GIT_TIMEOUT = 15_000;
// Issue/PR list responses include full bodies and repository objects; 30 open PRs measured
// at roughly 20 KB each, so a 256 KB cap failed on a real repository. Keep a hard upper bound.
const MAX_BUFFER = 8 * 1024 * 1024;
// Child processes get an allow-listed environment (never the whole process.env). Git never sees
// GH tokens or GIT_DIR / GIT_WORK_TREE; `gh` gets only its auth, config and proxy variables, so
// GH_HOST / GH_REPO / enterprise tokens cannot redirect it away from the parsed github.com origin.
const GIT_ENV = ['ProgramData', 'XDG_CONFIG_HOME'];
const GH_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'ProgramData',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

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
  name = name.replace(/\/$/, '').replace(/\.git$/, '');
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
    const isGit = program === 'git';
    const env = {
      ...childEnvironment(isGit ? GIT_ENV : GH_ENV),
      GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    };
    try {
      const output = await this.exec(program, args, {
        cwd, encoding:'utf8', timeout, maxBuffer:MAX_BUFFER, windowsHide:true, env,
      });
      return String(output).trim();
    } catch {
      // Never surface stderr; it may expose config, paths or credentials.
      throw new GitHubEvidenceError(502, isGit
        ? 'could not read the Git repository for this workspace'
        : 'read-only GitHub CLI request failed (check gh login, network and repository permissions)');
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
    const issues = [];
    let truncated = true;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rows = await this.fetchJson(`repos/${repo.fullName}/issues?state=open&per_page=${API_PAGE}&page=${page}`,repo.root);
      if (!Array.isArray(rows)) throw new GitHubEvidenceError(502, 'Unexpected GitHub issue response');
      // GitHub's Issues API includes PRs. Continue paging after filtering;
      // 100 open PRs must not masquerade as an empty issue tracker.
      issues.push(...rows.filter(x => !x.pull_request).map(x => ({
        number:Number(x.number),title:text(x.title,200),url:safeGithubLink(x.html_url),state:word(x.state)??'unknown',
      })));
      if (rows.length < API_PAGE) { truncated = issues.length > PAGE; break; }
      if (issues.length >= PAGE) break;
    }
    return { repo: repo.fullName, truncated, items: issues.slice(0,PAGE) };
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
  /**
   * Fresh provider-only snapshot for the task workflow's external gate.
   * No browser-supplied review/check result is trusted.
   */
  async verifyTaskPull(candidate, reference, sha) {
    const match = typeof reference === 'string'
      ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(reference) : null;
    if (!match || !SHA.test(sha)) throw new GitHubEvidenceError(400, 'invalid task PR reference or head SHA');
    const repo = await this.identify(candidate);
    if (`${match[1]}/${match[2]}`.toLowerCase() !== repo.fullName.toLowerCase()) {
      throw new GitHubEvidenceError(400, 'task PR belongs to a different repository');
    }
    const path = `repos/${repo.fullName}/pulls/${match[3]}`;
    const readHead = async () => {
      const pr = await this.fetchJson(path, repo.root);
      if (!pr || !SHA.test(pr.head?.sha) || pr.state !== 'open' || pr.draft
          || typeof pr.user?.login !== 'string' || !pr.user.login
          || safeGithubLink(pr.html_url)?.replace(/\/$/, '').toLowerCase() !== reference.toLowerCase()) {
        throw new GitHubEvidenceError(409, 'GitHub PR is missing, closed, draft, or has invalid metadata');
      }
      if (pr.head.sha !== sha) throw new GitHubEvidenceError(409, 'GitHub PR head changed; redo tests and review');
      return pr;
    };
    const first = await readHead();
    const latestByReviewer = new Map();
    let completeReviews = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.fetchJson(`${path}/reviews?per_page=${API_PAGE}&page=${page}`, repo.root);
      if (!Array.isArray(rows)) throw new GitHubEvidenceError(502, 'Unexpected GitHub review response');
      for (const review of rows) {
        const login = review.user?.login;
        if (!login || typeof login !== 'string') continue;
        const key = login.toLowerCase();
        const old = latestByReviewer.get(key);
        // REST reviews normally arrive chronologically. Compare IDs to
        // preserve last writer even if a provider response was reordered.
        if (!old || Number(review.id) > Number(old.id)) latestByReviewer.set(key, review);
      }
      if (rows.length < API_PAGE) { completeReviews = true; break; }
    }
    if (!completeReviews) throw new GitHubEvidenceError(409, 'GitHub PR review listing is incomplete');
    const approved = [...latestByReviewer.values()].find(x =>
      x.state === 'APPROVED' && x.commit_id === sha
      && x.user.login.toLowerCase() !== String(first.user?.login || '').toLowerCase()
      && safeGithubLink(x.html_url));
    if (!approved) throw new GitHubEvidenceError(409, 'no independent GitHub approval for this PR head');
    const checks = await this.checks(candidate, sha);
    if (!checks.complete || checks.verdict !== 'success') {
      throw new GitHubEvidenceError(409, 'GitHub CI is incomplete, pending, failed, or unavailable');
    }
    // Read again after multi-page reviews and CI: an updated PR head invalidates
    // the snapshot instead of silently attaching the previous commit's CI.
    await readHead();
    return {
      sha, prUrl: reference, reviewer: approved.user.login,
      reviewUrl: safeGithubLink(approved.html_url),
      checksUrl: `https://github.com/${repo.fullName}/commit/${sha}/checks`,
      verifiedAt: new Date().toISOString(),
    };
  }

  async checks(candidate, sha) {
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new GitHubEvidenceError(400, 'invalid commit SHA');
    const repo = await this.identify(candidate);
    const items = [];
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const row = await this.fetchJson(`repos/${repo.fullName}/commits/${sha}/check-runs?per_page=${API_PAGE}&page=${page}`, repo.root);
      if (!row || !Array.isArray(row.check_runs) || !Number.isSafeInteger(row.total_count)
          || row.total_count < 0 || row.check_runs.length > API_PAGE) {
        throw new GitHubEvidenceError(502, 'Unexpected GitHub check response');
      }
      if (total !== null && row.total_count !== total) {
        throw new GitHubEvidenceError(502, 'GitHub checks changed during pagination; refresh required');
      }
      total = row.total_count;
      items.push(...row.check_runs.map(x => ({
        id:Number(x.id),name:text(x.name,150),status:word(x.status)??'unknown',
        conclusion:word(x.conclusion),url:safeGithubLink(x.html_url),
      })));
      if (items.length >= total || row.check_runs.length < API_PAGE) break;
    }
    const checkRunsComplete = items.length === total;
    // Legacy commit status contexts are independent of Checks API. GitHub's
    // combined endpoint includes the most recent status for each context.
    // Treat >=100 returned contexts conservatively as potentially incomplete.
    const combined = await this.fetchJson(`repos/${repo.fullName}/commits/${sha}/status?per_page=${API_PAGE}`,repo.root);
    if (!combined || !Array.isArray(combined.statuses) || !['success','failure','pending','error'].includes(combined.state)
        || combined.statuses.length > API_PAGE) {
      throw new GitHubEvidenceError(502, 'Unexpected GitHub commit status response');
    }
    const statuses = combined.statuses.map(x => ({
      context:text(x.context,150),state:word(x.state)??'unknown',url:safeGithubLink(x.target_url),
    }));
    const complete = checkRunsComplete && statuses.length < API_PAGE;
    const bad = items.some(x => ['failure','cancelled','timed_out','action_required','startup_failure','stale'].includes(x.conclusion))
      || combined.state === 'failure' || combined.state === 'error'
      || statuses.some(x => ['failure','error'].includes(x.state));
    const pending = items.some(x => x.status !== 'completed' || !['success','skipped','neutral'].includes(x.conclusion))
      || combined.state === 'pending' || statuses.some(x => x.state === 'pending');
    // No checks AND no status contexts is absence of evidence, not a green build.
    const verdict = !complete ? 'unknown' : bad ? 'failure' : pending ? 'pending'
      : (items.length || statuses.length) ? 'success' : 'unknown';
    return {
      repo:repo.fullName, sha, total, truncated:!complete, complete,
      sources:['check_runs','commit_status'], verdict,
      statusState:combined.state, statuses, items,
    };
  }
}
