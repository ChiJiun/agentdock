import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntimeServer } from './server.mjs';
import { DEFAULT_MOCK } from './adapters.mjs';
import { GitHubEvidenceError, GitHubReader, parseGithubRemote } from './github-reader.mjs';

const READ_ONLY_PREFIX = ['api','--method','GET','--hostname','github.com','-H','Accept: application/vnd.github+json'];

function sampleRepo() {
  mkdirSync(resolve('.local'),{recursive:true});
  const dir=mkdtempSync(resolve('.local','gh-reader-test-'));
  execFileSync('git',['-C',dir,'init','-b','main'],{stdio:'ignore'});
  execFileSync('git',['-C',dir,'remote','add','origin','git@github.com:ChiJiun/agentdock.git'],{stdio:'ignore'});
  return { dir,close:()=>rmSync(dir,{recursive:true,force:true}) };
}
function fakeGh(url, { pullCount = 1, checkTotal, legacyState = 'success', issueCrowding = false, failChecksPage = 0 } = {}) {
  const page = Number(new URLSearchParams(url.split('?')[1] || '').get('page') || '1');
  if (url.includes('/issues?') && issueCrowding) {
    if (page === 1) return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      number: i+1, pull_request: {}, title: 'PR in issues', state: 'open',
    })));
    return JSON.stringify([{ number: 202, title: 'Real issue on page 2', state: 'open' }]);
  }
  if (url.includes('/issues?')) return JSON.stringify([
    {number:7,title:'Feature:\ntest',html_url:'https://github.com/ChiJiun/agentdock/issues/7',state:'open'},
    {number:8,title:'A PR in issues endpoint',pull_request:{url:'some'},html_url:'https://github.com/ChiJiun/agentdock/pull/8',state:'open'},
  ]);
  if (url.includes('/pulls?')) return JSON.stringify(Array.from({length:pullCount},(_,i)=>({
    number:11+i,title:'Open PR',html_url:i===0?'https://github.com/ChiJiun/agentdock/pull/11':'javascript:alert(1)',draft:false,state:'open',
    head:{sha:i===0?'a'.repeat(40):'not-a-sha'},
  })));
  if (url.includes('/check-runs?')) {
    if (page === failChecksPage) throw new Error('simulated failed pagination');
    const total = checkTotal ?? 1;
    return JSON.stringify({total_count:total,check_runs:Array.from({
      length: Math.max(0, Math.min(100, total - (page - 1) * 100)),
    },(_,i)=>({ id: (page-1)*100+i+17, name:'unit tests',status:'completed',
      conclusion:'success',html_url:'https://github.com/ChiJiun/agentdock/actions/runs/999' }))});
  }
  if (url.includes('/status?')) return JSON.stringify({
    state: legacyState, statuses:[{context:'legacy/build',state:legacyState === 'failure'?'failure':'success',
      target_url:'https://github.com/ChiJiun/agentdock/actions/runs/999'}],
  });
  throw new Error('unknown fake URL');
}
function makeExec(seen, options) {
  return async (program,args,opts) => {
    seen.push({program,args,opts});
    if (program==='git') return execFileSync(program,args,opts);
    assert.equal(program,'fake-gh');
    return fakeGh(args.at(-1), options);
  };
}

describe('read-only GitHub evidence (no writes)', () => {
  test('only accepts github.com origin in known remote formats', () => {
    assert.equal(parseGithubRemote('git@github.com:ChiJiun/agentdock.git').fullName,'ChiJiun/agentdock');
    assert.equal(parseGithubRemote('https://github.com/ChiJiun/agentdock').fullName,'ChiJiun/agentdock');
    assert.equal(parseGithubRemote('ssh://git@github.com/ChiJiun/agentdock.git').fullName,'ChiJiun/agentdock');
    assert.equal(parseGithubRemote('https://evil.test/ChiJiun/agentdock'),null);
    assert.equal(parseGithubRemote('https://github.com/../agentdock'),null);
    assert.equal(parseGithubRemote('https://github.com/ChiJiun/agentdock/evil'),null);
    assert.equal(parseGithubRemote('https://github.com/ChiJiun/agentdock.git?token=x'),null);
    assert.equal(parseGithubRemote('https://user:token@github.com/ChiJiun/agentdock.git'),null);
    assert.equal(parseGithubRemote('https://github.com.evil.test/ChiJiun/agentdock'),null);
    assert.equal(parseGithubRemote('https://github.com/ChiJiun/agentdock.git/').fullName,'ChiJiun/agentdock');
  });
  test('fetches Issues separately from PRs, with fixed read-only endpoint paths', async () => {
    const f=sampleRepo();
    const seen=[];
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:makeExec(seen,{pullCount:2})});
      const issues=await reader.issues(f.dir);
      const pulls=await reader.pulls(f.dir);
      assert.equal(issues.repo,'ChiJiun/agentdock');
      assert.deepEqual(issues.items.map(x=>x.number),[7]);
      assert.equal(issues.items[0].title,'Feature: test','untrusted titles are flattened to one line');
      assert.equal(issues.truncated,false);
      assert.deepEqual(pulls.items.map(x=>x.number),[11,12]);
      assert.equal(pulls.items[0].headSha,'a'.repeat(40));
      assert.equal(pulls.items[1].headSha,'','non-SHA head values are dropped');
      assert.equal(pulls.items[1].url,null,'non-github links are dropped');
      const gh=seen.filter(x=>x.program==='fake-gh');
      assert.deepEqual(gh.map(x=>x.args.slice(0,-1)),[READ_ONLY_PREFIX,READ_ONLY_PREFIX]);
      assert.deepEqual(gh.map(x=>x.args.at(-1)),[
        'repos/ChiJiun/agentdock/issues?state=open&per_page=100&page=1',
        'repos/ChiJiun/agentdock/pulls?state=open&per_page=30',
      ]);
    } finally {f.close();}
  });
  test('a full page is reported as truncated instead of complete', async () => {
    const f=sampleRepo();
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:makeExec([],{pullCount:30,checkTotal:501})});
      assert.equal((await reader.pulls(f.dir)).truncated,true);
      const checks=await reader.checks(f.dir,'a'.repeat(40));
      assert.equal(checks.total,501);
      assert.equal(checks.items.length,500);
      assert.equal(checks.truncated,true);
      assert.equal(checks.complete,false);
      assert.equal(checks.verdict,'unknown');
    } finally {f.close();}
  });
  test('checks require full SHA and never invoke remote writes', async () => {
    const f=sampleRepo();
    const seen=[];
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:makeExec(seen)});
      for (const bad of ['../branch','A'.repeat(40),'a'.repeat(39),'a'.repeat(40)+'/../../pulls',undefined]) {
        await assert.rejects(reader.checks(f.dir,bad),err=>err instanceof GitHubEvidenceError && err.status===400);
      }
      assert.equal(seen.length,0,'an invalid SHA is rejected before any process starts');
      const checks=await reader.checks(f.dir,'a'.repeat(40));
      assert.equal(checks.items[0].conclusion,'success');
      assert.equal(checks.truncated,false);
      const gh=seen.filter(x=>x.program==='fake-gh');
      assert.equal(gh.length,2);
      assert.deepEqual(gh.map(x=>x.args),[
        [...READ_ONLY_PREFIX,`repos/ChiJiun/agentdock/commits/${'a'.repeat(40)}/check-runs?per_page=100&page=1`],
        [...READ_ONLY_PREFIX,`repos/ChiJiun/agentdock/commits/${'a'.repeat(40)}/status?per_page=100`],
      ]);
    } finally {f.close();}
  });
  test('paginates more than 30 check runs and reports a failing legacy status', async () => {
    const f=sampleRepo();
    const seen=[];
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',
        exec:makeExec(seen,{checkTotal:135,legacyState:'failure'})});
      const result=await reader.checks(f.dir,'a'.repeat(40));
      assert.equal(result.items.length,135);
      assert.equal(result.total,135);
      assert.equal(result.complete,true);
      assert.equal(result.truncated,false);
      assert.equal(result.verdict,'failure');
      assert.deepEqual(result.sources,['check_runs','commit_status']);
      assert.deepEqual(result.statuses.map(x=>[x.context,x.state]),[['legacy/build','failure']]);
      const paths=seen.filter(x=>x.program==='fake-gh').map(x=>x.args.at(-1));
      assert.equal(paths.length,3);
      assert.match(paths[1],/check-runs\?per_page=100&page=2$/);
      assert.match(paths[2],/\/status\?per_page=100$/);
    } finally {f.close();}
  });
  test('pages past 100 pull requests in the Issues endpoint to find actual Issues', async () => {
    const f=sampleRepo();
    const seen=[];
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',
        exec:makeExec(seen,{issueCrowding:true})});
      const result=await reader.issues(f.dir);
      assert.deepEqual(result.items.map(x=>x.number),[202]);
      assert.equal(result.truncated,false);
      assert.equal(seen.filter(x=>x.program==='fake-gh').length,2);
    } finally {f.close();}
  });
  test('a failing later check page returns an error, never a partial green result', async () => {
    const f=sampleRepo();
    const seen=[];
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',
        exec:makeExec(seen,{checkTotal:135,failChecksPage:2})});
      await assert.rejects(reader.checks(f.dir,'a'.repeat(40)),
        e=>e instanceof GitHubEvidenceError && e.status===502 && !e.message.includes('simulated'));
      assert.equal(seen.filter(x=>x.program==='fake-gh').length,2);
    } finally {f.close();}
  });
  test('task gate verifies exact live PR head, independent review and both CI sources via GET only', async () => {
    const f = sampleRepo();
    const seen = [];
    const sha = 'a'.repeat(40);
    const prUrl = 'https://github.com/ChiJiun/agentdock/pull/24';
    const taskExec = async (program, args, opts) => {
      seen.push({program,args});
      if (program === 'git') return execFileSync(program,args,opts);
      const path = args.at(-1);
      if (path.endsWith('/pulls/24')) return JSON.stringify({
        head:{sha}, user:{login:'author'}, state:'open', draft:false, html_url:prUrl,
      });
      if (path.includes('/pulls/24/reviews?')) return JSON.stringify([
        {id:2, user:{login:'author'}, state:'APPROVED',commit_id:sha,html_url:prUrl+'#pullrequestreview-2'},
        {id:3, user:{login:'reviewer'}, state:'APPROVED',commit_id:sha,html_url:prUrl+'#pullrequestreview-3'},
      ]);
      return fakeGh(path);
    };
    try {
      const reader = new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:taskExec});
      const verified = await reader.verifyTaskPull(f.dir,prUrl,sha);
      assert.equal(verified.sha,sha);
      assert.equal(verified.reviewer,'reviewer');
      assert.match(verified.reviewUrl,/#pullrequestreview-3$/);
      assert.ok(Number.isFinite(Date.parse(verified.verifiedAt)));
      const gh = seen.filter(call=>call.program==='fake-gh');
      assert.deepEqual(gh.map(c=>c.args.slice(0,-1)),
        Array.from({length:5},()=>READ_ONLY_PREFIX));
      assert.equal(gh.filter(c=>c.args.at(-1).endsWith('/pulls/24')).length,2);
      assert.ok(gh.some(c=>c.args.at(-1).includes('/status?')));
    } finally { f.close(); }
  });
  test('task gate rejects changed PR head, self-review and legacy CI failure', async () => {
    const f = sampleRepo();
    const sha = 'a'.repeat(40), prUrl = 'https://github.com/ChiJiun/agentdock/pull/24';
    try {
      for (const scenario of ['head_changed','only_author','legacy_failure']) {
        let headReads=0;
        const exec=async(program,args,opts)=>{
          if(program==='git')return execFileSync(program,args,opts);
          const path=args.at(-1);
          if(path.endsWith('/pulls/24')) {
            headReads++;
            return JSON.stringify({head:{sha:scenario==='head_changed'&&headReads>1?'b'.repeat(40):sha},
              user:{login:'author'}, state:'open',draft:false,html_url:prUrl});
          }
          if(path.includes('/pulls/24/reviews?'))return JSON.stringify([{
            id:4,user:{login:scenario==='only_author'?'author':'reviewer'},
            state:'APPROVED',commit_id:sha,html_url:prUrl+'#pullrequestreview-4',
          }]);
          if(path.includes('/status?')&&scenario==='legacy_failure')return JSON.stringify({
            state:'failure',statuses:[{context:'legacy/build',state:'failure'}],
          });
          return fakeGh(path);
        };
        const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec});
        await assert.rejects(reader.verifyTaskPull(f.dir,prUrl,sha),
          e=>e instanceof GitHubEvidenceError && e.status===409);
      }
    } finally { f.close(); }
  });
  test('gh cannot be redirected to another host or repository by environment', async () => {
    const f=sampleRepo();
    const seen=[];
    const names=['GH_HOST','GH_REPO','GH_TOKEN','GIT_DIR','GIT_WORK_TREE','GIT_CONFIG_COUNT'];
    const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
    process.env.GH_HOST='evil.example';
    process.env.GH_REPO='someone/else';
    process.env.GH_TOKEN='test-token-not-real';
    process.env.GIT_WORK_TREE='/elsewhere';
    process.env.GIT_CONFIG_COUNT='0';
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:makeExec(seen)});
      await reader.issues(f.dir);
      assert.ok(seen.some(x=>x.program==='git')&&seen.some(x=>x.program==='fake-gh'));
      for (const entry of seen) {
        assert.equal(entry.opts.env.GH_HOST,undefined);
        assert.equal(entry.opts.env.GH_REPO,undefined);
        assert.equal(entry.opts.env.GIT_WORK_TREE,undefined);
        assert.equal(entry.opts.env.GIT_CONFIG_COUNT,undefined);
        // Only gh may see its token; git subprocesses never get it.
        assert.equal(entry.opts.env.GH_TOKEN,entry.program==='git'?undefined:'test-token-not-real');
        assert.equal(entry.opts.env.GH_PROMPT_DISABLED,'1');
        assert.equal(entry.opts.windowsHide,true);
        assert.ok(entry.opts.timeout>0);
      }
    } finally {
      for (const [key,value] of Object.entries(saved)) {
        if (value===undefined) delete process.env[key]; else process.env[key]=value;
      }
      f.close();
    }
  });
  test('gh failures never surface stderr or credential text', async () => {
    const f=sampleRepo();
    try {
      const exec=async (program,args,opts)=>{
        if (program==='git') return execFileSync(program,args,opts);
        const error=new Error('Command failed: gh api ... token ghp_SECRETSECRET');
        error.stderr='HTTP 401: Bad credentials ghp_SECRETSECRET';
        throw error;
      };
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec});
      await assert.rejects(reader.issues(f.dir),err=>{
        assert.ok(err instanceof GitHubEvidenceError);
        assert.equal(err.status,502);
        assert.doesNotMatch(err.message,/SECRET|ghp_|401/);
        return true;
      });
    } finally {f.close();}
  });
  test('working directory must be approved before reading remote evidence', async () => {
    const f=sampleRepo();
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:makeExec([])});
      await assert.rejects(reader.issues(resolve('/')),/outside/);
      await assert.rejects(reader.issues('relative'),/absolute/);
    } finally {f.close();}
  });
  test('/api/github refreshes approved roots, so a worktree swapped for a link is rejected before any process runs', async () => {
    const root=realpathSync(mkdtempSync(join(tmpdir(),'agentdock gh 測試-')));
    const repo=join(root,'src repo'), outside=join(root,'outside repo');
    mkdirSync(repo,{recursive:true}); mkdirSync(outside,{recursive:true});
    for (const dir of [repo,outside]) {
      execFileSync('git',['-C',dir,'init','-b','main'],{stdio:'ignore'});
      execFileSync('git',['-C',dir,'remote','add','origin','git@github.com:ChiJiun/agentdock.git'],{stdio:'ignore'});
    }
    writeFileSync(join(repo,'README.md'),'fixture\n');
    execFileSync('git',['-C',repo,'add','README.md']);
    execFileSync('git',['-C',repo,'-c','user.name=AgentDock Test','-c','user.email=test@example.invalid','commit','-m','fixture'],{stdio:'ignore'});
    const options={roots:[repo],dbPath:join(root,'store.db'),adapters:[DEFAULT_MOCK],worktreeRoot:join(root,'isolated')};
    const first=createRuntimeServer(options);
    const item=await first.worktrees.create({repoPath:repo});
    await first.close();
    // A restarted runtime trusts the registered worktree: it is in the shared roots array.
    const server=createRuntimeServer(options);
    try {
      assert.ok(server.allowedRoots.includes(item.path));
      renameSync(item.path,item.path+'-moved');
      symlinkSync(outside,item.path,process.platform==='win32'?'junction':'dir');
      // The stale root is still in the array until some request refreshes it.
      assert.ok(server.allowedRoots.includes(item.path));
      const url=`http://127.0.0.1:${(await server.listen(0)).port}`;
      const response=await fetch(`${url}/api/github/issues?cwd=${encodeURIComponent(item.path)}`);
      assert.equal(response.status,400);
      assert.match((await response.json()).error,/outside approved roots/);
    } finally {
      await server.close();
      rmSync(root,{recursive:true,force:true});
    }
  });
});
