import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { isIP } from 'node:net';

// Local development CA only. Production deployments should use their domain certificate.
let temporary;
try{
  const args=process.argv.slice(2),hosts=['localhost','127.0.0.1','::1'];let output=resolve('certs');
  while(args.length){
    const flag=args.shift(),value=args.shift();
    if(!value||!['--host','--out'].includes(flag))throw Error('用法：npm run https:setup -- [--host 局域网IP或域名] [--out 证书目录]');
    if(flag==='--out'){output=resolve(value);continue;}
    if(!isIP(value)&&!(value.length<=253&&value.split('.').every(p=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(p))))throw Error('无效的证书主机名。');
    hosts.push(value);
  }
  if(existsSync(output))throw Error('证书目录已存在，不会覆盖。需更换证书时请指定新的 --out 目录。');
  mkdirSync(dirname(output),{recursive:true});
  temporary=mkdtempSync(join(dirname(output),'.manxing-tls-'));chmodSync(temporary,0o700);
  const run=args=>execFileSync('openssl',args,{cwd:temporary,stdio:'pipe'});
  const san=[...new Set(hosts)].map(host=>`${isIP(host)?'IP':'DNS'}:${host}`).join(',');
  writeFileSync(join(temporary,'server.ext'),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,{mode:0o600});
  run(['req','-x509','-newkey','rsa:3072','-nodes','-sha256','-days','3650','-keyout','local-ca-key.pem','-out','local-ca.crt','-subj','/CN=Manxing Local Development CA','-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout','server-key.pem','-out','server.csr','-subj','/CN=localhost']);
  run(['x509','-req','-in','server.csr','-CA','local-ca.crt','-CAkey','local-ca-key.pem','-CAcreateserial','-out','server.crt','-days','365','-sha256','-extfile','server.ext']);
  for(const file of ['local-ca-key.pem','server-key.pem'])chmodSync(join(temporary,file),0o600);
  for(const file of ['server.csr','server.ext','local-ca.srl'])rmSync(join(temporary,file));
  renameSync(temporary,output);temporary=undefined;
  console.log(`本地 HTTPS 证书已生成（有效期 365 天），支持：${[...new Set(hosts)].join(', ')}\n请在 .env 中配置：\nTLS_CERT_FILE=${join(output,'server.crt')}\nTLS_KEY_FILE=${join(output,'server-key.pem')}\n仅将 ${join(output,'local-ca.crt')} 导入访问设备的受信任根证书。私钥请留在服务器。`);
}catch(error){
  // OpenSSL errors may include command details: never print its captured output.
  console.error(error.status!==undefined||error.code==='ENOENT'?'证书生成失败，请确认已安装 OpenSSL 1.1.1+。':error.message);process.exitCode=1;
}finally{if(temporary)rmSync(temporary,{recursive:true,force:true});}
