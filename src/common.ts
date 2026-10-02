import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE = resolve(ROOT, '.state');
export const PIPE = `\\\\.\\pipe\\dshcontroller-${createHash('sha256').update(ROOT.toLowerCase() + userInfo().username).digest('hex').slice(0,24)}`;
export const HOME = homedir();
export type Obj = Record<string, any>;
export class ControllerError extends Error {
  constructor(public code: string, message: string, public details: Obj = {}) { super(message); }
}
export function errorOf(e: unknown) {
  return e instanceof ControllerError ? {code:e.code,message:e.message,details:redact(e.details)} : {code:'internal',message:safeMessage(e instanceof Error ? e.message : String(e))};
}
export function safeMessage(s: string) { return s.replace(/([?&]token=)[^\s&"']+/gi,'$1<redacted>').replace(/(cookie|authorization):[^\r\n]+/gi,'$1: <redacted>'); }
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(apiKey|accessToken|refreshToken|cookie|authorization|secret|password)$/i.test(k) ? '<redacted>' : redact(v)]));
  return typeof value === 'string' ? safeMessage(value) : value;
}
export function assertLocalUrl(value: string) {
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password) throw new ControllerError('invalid-target','Only a loopback DSH instance is supported.');
  return url;
}
export const delay = (ms:number) => new Promise<void>(r => setTimeout(r,ms));
export type Instance = {instanceId:string;pid:number;startedAt:string;version:string;versionDir:string;profile:string;baseUrl:string;window?:{pid:number;handle:string;title:string;path:string}|null};
