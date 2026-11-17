import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionStore } from './store.mjs';
import { WorktreeManager } from './worktrees.mjs';
import { createRuntimeServer } from './server.mjs';
import { DEFAULT_MOCK } from './adapters.mjs';

function fixture() {
  mkdirSync(resolve('.local'),{recursive:true});
  const root = mkdtempSync(resolve('.local','worktree-fixture-'));
  const repo = join(root,'repo');
  const worktreeRoot = join(root,'isolated');
  mkdirSync(repo,{recursive:true});
  const git = (...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',timeout:4000});
  git('init','-b','main');
  writeFileSync(join(repo,'README.md'),'Original fixture\n');
  git('add','README.md');
  git('-c','user.name=AgentDock Test','-c','user.email=test@example.invalid','commit','-m','fixture');
  return {root,repo,worktreeRoot,git,close:()=>rmSync(root,{recursive:true,force:true})};
}

describe('safe worktree-per-task isolation', () => {
  test('creates new isolated branch/worktree without modifying original branch or files', async () => {
    const f=fixture(), db=new SessionStore(':memory:');
    try {
      const manager=new WorktreeManager({store:db,sourceRoots:[f.repo],worktreeRoot:f.worktreeRoot});
      const before=f.git('rev-parse','HEAD').trim();
      const item=await manager.create({repoPath:f.repo});
      assert.ok(item.branch.startsWith('agentdock/task-'));
      assert.equal(item.exists,true);
      assert.deepEqual(manager.list().map(x=>x.path),[item.path]);
      assert.equal(readFileSync(join(item.path,'README.md'),'utf8'),'Original fixture\n');
      const worktreeHead=execFileSync('git',['-C',item.path,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
      assert.equal(before,worktreeHead);
      assert.equal(f.git('branch','--show-current').trim(),'main');
      writeFileSync(join(item.path,'README.md'),'Changed ONLY in isolated worktree\n');
      assert.equal(readFileSync(join(f.repo,'README.md'),'utf8'),'Original fixture\n');
      assert.equal(f.git('status','--porcelain').trim(),'');
      assert.equal(manager.permittedWorkspacePaths()[0],realpathSync(item.path));
      assert.equal(db.listWorktrees()[0].branch,item.branch);
    } finally {db.close();f.close();}
  });

  test('rejects paths outside permitted roots, including traversal and symlinks', async () => {
    const f=fixture(), db=new SessionStore(':memory:');
    try {
      const manager=new WorktreeManager({store:db,sourceRoots:[f.repo],worktreeRoot:f.worktreeRoot});
      await assert.rejects(manager.create({repoPath:'..'}),/absolute|workspace/);
      await assert.rejects(manager.create({repoPath:'/'}),/outside/);
      await assert.rejects(manager.create({repoPath:join(f.root,'not-a-repo')}),/ENOENT|workspace|path/);
      assert.equal(db.listWorktrees().length,0);
    } finally {db.close();f.close();}
  });

  test('local API only creates when explicitly posted and makes isolated folder available for ACP', async () => {
    const f=fixture();
    const server=createRuntimeServer({roots:[f.repo],dbPath:':memory:',adapters:[DEFAULT_MOCK],worktreeRoot:f.worktreeRoot});
    const address=await server.listen(0);
    const url=`http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await (await fetch(url+'/api/worktrees')).json()).length,0);
      const rejected=await fetch(url+'/api/worktrees',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.invalid'},body:JSON.stringify({repoPath:f.repo})});
      assert.equal(rejected.status,403);
      const r=await fetch(url+'/api/worktrees',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repoPath:f.repo})});
      assert.equal(r.status,201);
      const created=await r.json();
      const roots=await (await fetch(url+'/api/workspaces')).json();
      assert.ok(roots.some(x=>x.path===created.path));
      const s=await fetch(url+'/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({adapterId:'mock',cwd:created.path})});
      assert.equal(s.status,201);
      assert.equal((await s.json()).cwd,created.path);
      assert.equal(f.git('branch','--show-current').trim(),'main');
    } finally {await server.close();f.close();}
  });

  test('registered worktrees remain available after runtime restart', async () => {
    const f=fixture(), dbPath=join(f.root,'store.db');
    let server=createRuntimeServer({roots:[f.repo],dbPath,adapters:[DEFAULT_MOCK],worktreeRoot:f.worktreeRoot});
    try {
      const item=await server.worktrees.create({repoPath:f.repo});
      const path=item.path;
      await server.close();
      server=createRuntimeServer({roots:[f.repo],dbPath,adapters:[DEFAULT_MOCK],worktreeRoot:f.worktreeRoot});
      assert.ok(server.allowedRoots.includes(path));
      assert.equal(server.worktrees.list()[0].exists,true);
    } finally {await server.close();f.close();}
  });
});
