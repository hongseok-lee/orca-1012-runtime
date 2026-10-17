/** Fixed bootstrap only; neither a path nor executable source comes from RPC.
 * The original owned bundle is checked before requiring it. No provider env or
 * token appears in argv, exec URL, a digest, or operator-visible output. */
export const agentCodexBootstrap = `const fs=require('node:fs'),crypto=require('node:crypto');
const path='/tmp/orca-agent-control.cjs',fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
const stat=fs.fstatSync(fd),bytes=fs.readFileSync(fd);fs.closeSync(fd);
if(!stat.isFile()||stat.uid!==1000||stat.nlink!==1||bytes.length>4194304||crypto.createHash('sha256').update(bytes).digest('hex')!==process.argv[1])throw Error('AGENT_CONTROL_BUNDLE');
const execute=require('node:vm').runInThisContext('(function(require,module,exports,__filename,__dirname){\\n'+bytes.toString('utf8')+'\\n})',{filename:path});
const owned={exports:{}};execute(require,owned,owned.exports,path,'/tmp');`

export const agentControlTransfer = `const fs=require('node:fs'),crypto=require('node:crypto');
const chunks=[];let length=0;
process.stdin.on('data',b=>{length+=b.length;if(length>4194304)process.exit(1);chunks.push(b)});
process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks);if(crypto.createHash('sha256').update(bytes).digest('hex')!==process.argv[1])process.exit(1);
const fd=fs.openSync('/tmp/orca-agent-control.cjs',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}});`

