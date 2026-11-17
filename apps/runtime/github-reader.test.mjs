import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GitHubReader, parseGithubRemote } from './github-reader.mjs';

function sampleRepo() {
  mkdirSync(resolve('.local'),{recursive:true});
  const dir=mkdtempSync(resolve('.local','gh-reader-test-'));
  execFileSync('git',['-C',dir,'init','-b','main'],{stdio:'ignore'});
  execFileSync('git',['-C',dir,'remote','add','origin','git@github.com:ChiJiun/agentdock.git'],{stdio:'ignore'});
  return { dir,close:()=>rmSync(dir,{recursive:true,force:true}) };
}
function fakeExec(program,args,opts) {
  if (program==='git') return execFileSync(program,args,opts);
  assert.equal(program,'fake-gh');
  assert.equal(args[0],'api');
  const url=args.at(-1);
  if (url.includes('/issues?')) return JSON.stringify([
    {number:7,title:'Feature: test',html_url:'https://github.com/ChiJiun/agentdock/issues/7',state:'open'},
    {number:8,title:'A PR in issues endpoint',pull_request:{url:'some'},html_url:'https://github.com/ChiJiun/agentdock/pull/8',state:'open'},
  ]);
  if (url.includes('/pulls?')) return JSON.stringify([{
    number:11,title:'Open PR',html_url:'https://github.com/ChiJiun/agentdock/pull/11',draft:false,state:'open',
    head:{sha:'a'.repeat(40)},
  }]);
  if (url.includes('/check-runs?')) return JSON.stringify({check_runs:[
    {id:17,name:'unit tests',status:'completed',conclusion:'success',html_url:'https://github.com/ChiJiun/agentdock/actions/runs/999'},
  ]});
  throw new Error('unknown fake URL');
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
  });
  test('fetches Issues separately from PRs, with fixed read-only endpoint paths', () => {
    const f=sampleRepo();
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:fakeExec});
      const issues=reader.issues(f.dir);
      const pulls=reader.pulls(f.dir);
      assert.equal(issues.repo,'ChiJiun/agentdock');
      assert.deepEqual(issues.items.map(x=>x.number),[7]);
      assert.deepEqual(pulls.items.map(x=>x.number),[11]);
      assert.equal(pulls.items[0].headSha,'a'.repeat(40));
    } finally {f.close();}
  });
  test('checks require full SHA and never invoke remote writes', () => {
    const f=sampleRepo();
    const seen=[];
    const exec=(program,args,opts)=>{
      seen.push({program,args});
      return fakeExec(program,args,opts);
    };
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec});
      assert.throws(()=>reader.checks(f.dir,'../branch'),/invalid commit SHA/);
      const checks=reader.checks(f.dir,'a'.repeat(40));
      assert.equal(checks.items[0].conclusion,'success');
      assert.equal(seen.filter(x=>x.program==='fake-gh').length,1);
      for (const entry of seen.filter(x=>x.program==='fake-gh')) {
        assert.equal(entry.args[0],'api');
        assert.equal(entry.args.length,4); // api -H Accept path
      }
    } finally {f.close();}
  });
  test('working directory must be approved before reading remote evidence', () => {
    const f=sampleRepo();
    try {
      const reader=new GitHubReader({roots:[f.dir],ghBin:'fake-gh',exec:fakeExec});
      assert.throws(()=>reader.issues('/'),/outside/);
      assert.throws(()=>reader.issues('relative'),/absolute/);
    } finally {f.close();}
  });
});
