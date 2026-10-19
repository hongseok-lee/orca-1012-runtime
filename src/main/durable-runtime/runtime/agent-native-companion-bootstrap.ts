/** Fixed maintenance bootstrap; only reviewed bytes execute. Arguments carry
 * public identity/hash metadata, never tokens, account data or launch env. */
export const nativeCompanionRepairBootstrap = `const fs=require('node:fs'),crypto=require('node:crypto');
if(!/^[0-9a-f]{64}$/.test(process.argv[1]))throw Error('NATIVE_REPAIR_BUNDLE');
const path='/tmp/orca-native-companion-repair-'+process.argv[1]+'.cjs',fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
const stat=fs.fstatSync(fd),bytes=fs.readFileSync(fd);fs.closeSync(fd);
if(!stat.isFile()||stat.uid!==1000||stat.nlink!==1||bytes.length>4194304||crypto.createHash('sha256').update(bytes).digest('hex')!==process.argv[1])throw Error('NATIVE_REPAIR_BUNDLE');
const execute=require('node:vm').runInThisContext('(function(require,module,exports,__filename,__dirname){\\n'+bytes.toString('utf8')+'\\n})',{filename:path});
const owned={exports:{}};execute(require,owned,owned.exports,path,'/tmp');`
