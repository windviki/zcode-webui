import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

// get ws token from the served index
const BASE = process.env.ZCODE_WEBUI_TEST_URL || 'http://127.0.0.1:3102/';
const idx = await fetch(BASE).then((r) => r.text());
const m = /window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/.exec(idx);
const cfg = JSON.parse(m[1]);
const wsToken = cfg.wsToken;

function vql(v){const b=[];if(v===0)b.push(0);else{let x=v;while(x!==0){b.push(x&127);x=x>>>7;}for(let i=0;i<b.length-1;i++)b[i]|=128;}return Buffer.from(b);}
function ser(d){const p=[];if(d===undefined)p.push(Buffer.from([0]));else if(typeof d==='string'){const b=Buffer.from(d);p.push(Buffer.from([1]),vql(b.length),b);}else if(Array.isArray(d)){p.push(Buffer.from([4]),vql(d.length));for(const e of d)p.push(ser(e));}else if(typeof d==='number'){p.push(Buffer.from([6]),vql(d));}else if(d&&typeof d==='object'){const b=Buffer.from(JSON.stringify(d));p.push(Buffer.from([5]),vql(b.length),b);}return Buffer.concat(p);}
function readVQL(buf, off){let v=0,n=0;for(;;){const b=buf[off++];v|=(b&127)<<n;if(!(b&128))return [v>>>0,off];n+=7;}}
function des(buf, off){const t=buf[off++];switch(t){case 0:return [undefined,off];case 1:{const [l,o2]=readVQL(buf,off);return [buf.subarray(o2,o2+l).toString('utf8'),o2+l];}case 2:case 3:{const [l,o2]=readVQL(buf,off);return [buf.subarray(o2,o2+l),o2+l];}case 4:{const [l,o2]=readVQL(buf,off);const arr=[];let o3=o2;for(let i=0;i<l;i++){const [v,o4]=des(buf,o3);arr.push(v);o3=o4;}return [arr,o3];}case 5:{const [l,o2]=readVQL(buf,off);return [JSON.parse(buf.subarray(o2,o2+l).toString('utf8')),o2+l];}case 6:{const [v,o2]=readVQL(buf,off);return [v,o2];}default:throw new Error('preset '+t);}}

const ws = new WebSocket(BASE.replace(/^http/, 'ws') + 'ws?token=' + wsToken);
ws.binaryType = 'arraybuffer';
ws.on('message', (data, isBinary) => {
  if (!isBinary) { console.log('text:', String(data).slice(0, 80)); return; }
  const payload = Buffer.from(data);
  const [header] = des(payload, 0);
  if (Array.isArray(header) && header[0] === 201 && header[1] === 1) {
    const [body, off] = des(payload, 0);
    const [b2] = des(payload, off);
    const provs = b2 && b2.providers || [];
    console.log('registry providers (' + provs.length + '):');
    for (const p of provs) {
      console.log('  ' + p.providerId);
      console.log('    baseURL=' + JSON.stringify(p.baseURL) + ' apiKeyRequired=' + p.apiKeyRequired);
      console.log('    apiKeyPresent=' + !!p.apiKey + ' enabled=' + p.enabled + ' models=' + (p.models || []).map((m) => m.modelId + (m.disabledReason ? '(' + m.disabledReason + ')' : '')).join(','));
    }
    ws.close(); process.exit(0);
  }
});
ws.on('open', () => {
  setTimeout(() => {
    const req = Buffer.concat([ser([100, 1, 'model-provider', 'getProviderRegistrySnapshot']), ser(undefined)]);
    ws.send(req);
  }, 2500);
});
setTimeout(() => { console.log("timeout"); process.exit(1); }, 200000);
