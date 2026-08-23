// Raw WebSocket round-trip through the code-server proxy (default /proxy/3102/).
// Usage: ZCODE_WEBUI_PROXY_URL=http://127.0.0.1:8080/proxy/3102/ node scripts/dev/cs-ws-test.mjs
import WebSocket from 'ws';

const base = (process.env.ZCODE_WEBUI_PROXY_URL || 'http://127.0.0.1:8080/proxy/3102/').replace(/\/?$/, '/');
const idx = await fetch(base).then((r) => r.text());
const m = /window\.__ZCODE_WEBUI_CONFIG__ = (\{.*?\});/.exec(idx);
if (!m) { console.error('no injected config in index'); process.exit(2); }
const cfg = JSON.parse(m[1]);

// Minimal channel message writer for tests (mirrors the official wire format).
function vql(v){const b=[];if(v===0)b.push(0);else{let x=v;while(x!==0){b.push(x&127);x=x>>>7;}for(let i=0;i<b.length-1;i++)b[i]|=128;}return Buffer.from(b);}
function ser(d){const p=[];if(d===undefined)p.push(Buffer.from([0]));else if(typeof d==='string'){const b=Buffer.from(d);p.push(Buffer.from([1]),vql(b.length),b);}else if(Array.isArray(d)){p.push(Buffer.from([4]),vql(d.length));for(const e of d)p.push(ser(e));}else if(typeof d==='number'){p.push(Buffer.from([6]),vql(d));}else if(d&&typeof d==='object'){const b=Buffer.from(JSON.stringify(d));p.push(Buffer.from([5]),vql(b.length),b);}return Buffer.concat(p);}
const req=Buffer.concat([ser([100,1,'system','info']),ser(undefined)]);
const ws=new WebSocket(base.replace(/^http/, 'ws') + 'ws?token=' + cfg.wsToken);
let init=false, replied=false;
ws.on('message',(d,b)=>{
  if(!b){console.log('txt',String(d).slice(0,80));return;}
  const p=Buffer.from(d);
  console.log('BIN', p.length, p.toString('hex').slice(0,40));
  if(!init && p.toString('hex')==='040106c80100'){init=true;console.log('send system.info');ws.send(req);}
  else if(init && !replied){replied=true;console.log('ROUND-TRIP OK');ws.close();process.exit(0);}
});
ws.on('open',()=>console.log('open'));
ws.on('error',(e)=>console.log('error',e.message));
setTimeout(()=>{console.log('TIMEOUT');process.exit(1);},20000);
