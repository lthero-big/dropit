import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../www/core.js';

// Execute the actual startup and click handlers with a minimal DOM/native
// bridge. A previously skipped version must not bypass a later forced policy.
for (const policy of [{force:true},{minVersionCode:5}]) {
  test('startup enforces update despite remembered skip '+JSON.stringify(policy), async () => {
    const source=(await readFile(new URL('../www/app.js',import.meta.url),'utf8'))
      .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g,'');
    const elements=new Map();
    const element=id=> {
      if(!elements.has(id)) elements.set(id,{hidden:false,onclick:null,textContent:''});
      return elements.get(id);
    };
    const storage=new Map([['server','https://drop.test'],['token','test-token'],['skipUpdate','5']]);
    const calls=[], timers=[];
    let replaced=false;
    const context=vm.createContext({...core, BUILD:{version:'0.3.1',code:4},
      window:{Capacitor:{Plugins:{DropitShare:{appInfo:async()=>({versionCode:4}),take:async()=>({}),setServer:async()=>{},addListener:()=>{}},
        CapacitorHttp:{request:async({url})=>{
          calls.push(url);
          if(url.endsWith('/api/app/android/latest')) return {status:200,data:{versionCode:5,versionName:'0.3.2',size:20,sha256:'a'.repeat(64),url:'/api/app/android/download/test.apk',...policy}};
          return {status:200,data:{path:'/api/app-session?ticket='+'a'.repeat(43)}};
        }}}}},
      document:{getElementById:element},navigator:{userAgent:'Android'},
      localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
      sessionStorage:{getItem:()=>null,setItem:()=>{}},
      location:{hash:'',replace:()=>{replaced=true;}},URL,
      setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},
    });
    vm.runInContext(source,context);
    for(let i=0;i<30;i++) await new Promise(r=>setImmediate(r));
    assert.equal(element('update').hidden,false);
    assert.equal(element('upd-later').hidden,true);
    assert.equal(element('upd-skip').hidden,true);
    assert.equal(replaced,false);
    assert.ok(!calls.some(u=>u.includes('/api/app-session/ticket')));
    // Hidden dismissal controls must not provide a programmatic bypass either.
    element('upd-later').onclick?.();element('upd-skip').onclick?.();
    for(let i=0;i<10;i++) await new Promise(r=>setImmediate(r));
    assert.equal(replaced,false);
  });
}
