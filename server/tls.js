import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';

// Explicit configuration only: broken TLS configuration must never fall back to HTTP.
export async function loadTls(env=process.env){
  const certFile=env.TLS_CERT_FILE?.trim(),keyFile=env.TLS_KEY_FILE?.trim();
  if(!certFile&&!keyFile)return undefined;
  if(!certFile||!keyFile)throw new Error('HTTPS 需要同时配置 TLS_CERT_FILE 和 TLS_KEY_FILE。');
  let cert,key;
  try{[cert,key]=await Promise.all([readFile(certFile),readFile(keyFile)]);}
  catch{throw new Error('HTTPS 证书或私钥无法读取，请检查文件路径与权限。');}
  try{createSecureContext({cert,key,minVersion:'TLSv1.2'});}
  catch{throw new Error('HTTPS 证书或私钥格式无效或不匹配，请重新配置。');}
  return {cert,key,minVersion:'TLSv1.2'};
}
