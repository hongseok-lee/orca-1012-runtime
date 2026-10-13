import { readFile, realpath, stat } from 'node:fs/promises';
import { StorageError, type DirectoryObservation } from './canonical.ts';

// Run only within the intended server's filesystem namespace. These supplied
// subject labels are not authenticated by a local filesystem read. The result
// remains raw metadata, never VerifiedDirectoryEvidence or a writer permission.
export async function observeLocalDirectory(input: Readonly<{
  path: string; backingPath: string; podUid: string; generation: string;
}>): Promise<DirectoryObservation> {
  try {
    const [resolved, backingResolved, mountinfo] = await Promise.all([
      realpath(input.path), realpath(input.backingPath), readFile('/proc/self/mountinfo', 'utf8'),
    ]);
    const [first, second] = await Promise.all([
      stat(resolved, { bigint: true }), stat(backingResolved, { bigint: true }),
    ]);
    // Detect observed rename/symlink or topology changes during this sample.
    const [again, backingAgain, mountinfoAgain, statAgain, backingStatAgain] = await Promise.all([
      realpath(input.path), realpath(input.backingPath), readFile('/proc/self/mountinfo', 'utf8'),
      stat(resolved, { bigint: true }), stat(backingResolved, { bigint: true }),
    ]);
    if (resolved !== again || backingResolved !== backingAgain || mountinfo !== mountinfoAgain ||
        first.dev !== statAgain.dev || first.ino !== statAgain.ino ||
        second.dev !== backingStatAgain.dev || second.ino !== backingStatAgain.ino)
      throw new StorageError('OBSERVATION_CHANGED');
    return { podUid: input.podUid, generation: input.generation, realPath: resolved,
      backingPath: input.backingPath, backingRealPath: backingResolved, mountinfo,
      stat: { device: first.dev.toString(), inode: first.ino.toString(), directory: first.isDirectory() },
      backingStat: { device: second.dev.toString(), inode: second.ino.toString(), directory: second.isDirectory() } };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    // Preserve an error class without copying paths, syscall messages or bodies.
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    throw new StorageError(code === 'ENOENT' ? 'METADATA_NOT_FOUND' : code === 'EACCES' || code === 'EPERM'
      ? 'METADATA_PERMISSION' : 'METADATA_UNAVAILABLE');
  }
}
