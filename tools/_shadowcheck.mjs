import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT=5200+Math.floor(Math.random()*3000);
const proc=spawn('npx',['vite','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('vite')),30000);proc.stdout.on('data',d=>{if(/Local:|ready in/i.test(String(d))){clearTimeout(t);setTimeout(r,600);}});});
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:640,height:360}});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${PORT}?quality=high&nofrontend=1`,{waitUntil:'load'});
await p.waitForFunction(()=>document.body.dataset.ready==='1',null,{timeout:300000});
await p.waitForTimeout(4000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const e=window.__engine, r=e.renderer||e.get('render').renderer;
  const NAMES={0:'BasicShadowMap',1:'PCFShadowMap',2:'PCFSoftShadowMap',3:'VSMShadowMap'};
  let casters=0, receivers=0, both=0;
  e.scene.traverse(o=>{ if(!o.isMesh) return; if(o.castShadow) casters++; if(o.receiveShadow) receivers++; if(o.castShadow&&o.receiveShadow) both++; });
  const lig=e.get('lighting');
  return {
    shadowTypeNum:r.shadowMap.type, shadowType:NAMES[r.shadowMap.type]||'?',
    enabled:r.shadowMap.enabled,
    cascades: lig?.csm?.cascades?.length ?? lig?.csm?.count ?? null,
    sunElevationSetting: e.sunDirection ? +Math.asin(e.sunDirection.y).toFixed(3) : null,
    sunIntensity: e.sun?.intensity ?? null,
    casters, receivers, both,
    drawCalls:r.info.render.calls, tris:r.info.render.triangles,
  };
}),null,2));
console.log(errs.length?`ERRORS: ${errs.slice(0,3).join(' | ')}`:'no page errors');
await b.close(); proc.kill(); process.exit(0);
