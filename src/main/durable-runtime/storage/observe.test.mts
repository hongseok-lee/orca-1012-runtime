import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { observeLocalDirectory } from './observe.ts';
import { canonicalizeObservation, containsPath, parseMountInfo, sameDirectory, StorageError } from './canonical.ts';

test('local metadata reader resolves owned fixture symlink and reports safe missing-path class',async()=>{
  const root='/tmp/orca-p110-execution/observer-fixture-'+randomUUID();
  await mkdir(root);await mkdir(root+'/home');await symlink(root+'/home',root+'/alias');
  const subject={podUid:'synthetic-observer-subject',generation:'synthetic-generation-1'};
  const first=await observeLocalDirectory({...subject,path:root+'/alias',backingPath:root+'/home'});
  const second=await observeLocalDirectory({...subject,path:root+'/home',backingPath:root+'/home'});
  assert.equal(first.realPath,root+'/home');assert.equal(first.stat.inode,second.stat.inode);
  const mount=parseMountInfo(first.mountinfo).filter(m=>containsPath(m.point,first.realPath)).sort((a,b)=>b.point.length-a.point.length)[0];
  const physicalRoot=path.posix.join(mount.root,path.posix.relative(mount.point,root));
  const authority={domain:{backendId:'synthetic-local-filesystem',exportId:'synthetic-domain',pvUid:'synthetic-pv'},
    ...subject,backingRoot:physicalRoot,allowedMountIds:[mount.id]};
  const a=canonicalizeObservation(first,authority),b=canonicalizeObservation(second,authority);
  assert.equal(a.canonicalDirectory,'/home');assert.ok(sameDirectory(a,b));
  await assert.rejects(observeLocalDirectory({...subject,path:root+'/absent',backingPath:root+'/home'}),e=>e instanceof StorageError && e.code==='METADATA_NOT_FOUND' && !e.message.includes(root));
  // Retained only in this role's disposable /tmp; no existing file is removed.
});
