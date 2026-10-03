import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ProviderRegistry, validateEndpoint, isPublicAddress } from '../server/providers.mjs';
import { postPublicHTTPS } from '../server/public-https.mjs';
import { readSSE } from '../server/sse.mjs';

const streamed=(events,chunk=7)=>{
  const encoded=new TextEncoder().encode(events);
  return new Response(new ReadableStream({start(controller){for(let i=0;i<encoded.length;i+=chunk)controller.enqueue(encoded.slice(i,i+chunk));controller.close();}}),{status:200});
};
const collect=async stream=>{let result='';for await(const piece of stream)result+=piece;return result;};
const history=[{role:'user',content:'你好'}];

test('SSE parser handles Chinese UTF-8 boundaries, CRLF and multiline payload',async()=>{
  const response=streamed(': comment\r\nevent: reply\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n',1);
  const events=[];for await(const event of readSSE(response.body))events.push(event);
  assert.deepEqual(events,[{event:'reply',data:'第一行\n第二行'}]);
});

test('ChatGPT transport uses the public Responses contract and carries local history',async()=>{
  const requests=[];
  const registry=new ProviderRegistry({getAccessToken:async()=>'fake-test-token',fetchImpl:async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'Test',visibility:'list'},{slug:'hidden',visibility:'hidden'}]});
    return streamed('data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.completed"}\n\n');
  }});
  assert.deepEqual(await registry.models('chatgpt'),[{id:'test-model',name:'Test'}]);
  assert.equal(await collect(registry.stream({providerId:'chatgpt',model:'test-model',history,name:'伙伴'})),'你好');
  assert.equal(requests[1].url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(requests[1].options.body);
  assert.equal(body.store,false);assert.equal(body.stream,true);assert.deepEqual(body.input,history);
  assert.equal(body.temperature,undefined);assert.equal(body.previous_response_id,undefined);
  assert.equal(requests[1].options.redirect,'error');
});

test('An incomplete stream never reports successful completion; raw upstream errors stay private',async()=>{
  for(const terminal of ['', 'data: {"type":"response.failed","response":{"error":{"message":"Bearer secret-test"}}}\n\n']){
    const registry=new ProviderRegistry({getAccessToken:async()=>'test',fetchImpl:async()=>streamed('data: {"type":"response.output_text.delta","delta":"部分"}\n\n'+terminal)});
    registry.chatgptModels=[{id:'test',name:'Test'}];
    await assert.rejects(collect(registry.stream({providerId:'chatgpt',model:'test',name:'Test',history})),error=>!error.message.includes('secret-test'));
  }
});

test('Provider failures do not retry or leak body content',async()=>{
  let calls=0;
  const registry=new ProviderRegistry({getAccessToken:async()=>'test',fetchImpl:async()=>{calls++;return new Response('secret provider diagnostic',{status:429});}});
  registry.chatgptModels=[{id:'test',name:'Test'}];
  await assert.rejects(collect(registry.stream({providerId:'chatgpt',model:'test',name:'Test',history})),/额度/);
  assert.equal(calls,1);
});

test('Demo streams are explicitly labeled and cancellation stops generation',async()=>{
  const registry=new ProviderRegistry({demoDelay:0,getAccessToken:()=>{throw new Error('must not access token');}});
  const text=await collect(registry.stream({providerId:'demo',model:'demo-guide',name:'Guide',history}));
  assert.match(text,/测试适配器 · 未调用真实模型/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(collect(registry.stream({providerId:'demo',model:'demo-guide',name:'Guide',history,signal:controller.signal})),{name:'AbortError'});
});

test('Compatible endpoints reject local, private, plaintext, redirects and OpenAI key routes',async()=>{
  const publicDNS=async()=>[{address:'8.8.8.8'}];
  for(const url of ['http://example.com/v1','https://127.0.0.1/v1','https://localhost/v1','https://api.openai.com/v1','https://example.com/?key=x','https://user:pass@example.com/v1'])await assert.rejects(validateEndpoint(url,publicDNS));
  await assert.rejects(validateEndpoint('https://rebind.example/v1',async()=>[{address:'10.0.0.1'}]));
  assert.equal(await validateEndpoint('https://api.example.com/v1/',publicDNS),'https://api.example.com/v1');
  for(const address of ['::1','::ffff:127.0.0.1','fc00::1','fe80::1','169.254.169.254','192.168.1.3','172.16.1.1'])assert.equal(isPublicAddress(address),false);
});

test('Compatible provider secret is omitted from all public metadata',async()=>{
  const registry=new ProviderRegistry({lookupImpl:async()=>[{address:'8.8.8.8'}]});
  const p=await registry.addCompatible({name:'Example',baseUrl:'https://api.example.com/v1',apiKey:'test-private-value',models:['model']});
  assert.equal(JSON.stringify(p).includes('test-private-value'),false);
  assert.equal(JSON.stringify(registry.list()).includes('test-private-value'),false);
  registry.remove(p.id);assert.equal(registry.hasModel(p.id,'model'),undefined);
});

function fakeHTTPS({status=200,payload='',hold=false,holdHeaders=false,failRequest=false,failBody=false,beforeReply}={}) {
  const calls=[];
  const requestImpl=(options,callback)=>{
    const req=new EventEmitter(); const res=new PassThrough(); res.statusCode=status;
    req.destroyed=false; req.destroy=()=>{req.destroyed=true;};
    const call={options,req,res,body:null}; calls.push(call);
    req.end=body=>{call.body=body;queueMicrotask(()=>{
      beforeReply?.(call);
      if(failRequest){req.emit('error',new Error('private request diagnostic test-secret'));return;}
      if(holdHeaders)return;
      callback(res);
      if(failBody){res.destroy(new Error('private body diagnostic test-secret'));return;}
      if(!hold)res.end(payload);
    });};
    return req;
  };
  return {calls,requestImpl};
}
const publicDNS=async()=>[{address:'8.8.8.8',family:4}];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const lookupFrom=(options,all=false)=>new Promise((resolve,reject)=>options.lookup(options.hostname,{all},(error,address,family)=>error?reject(error):resolve(all?address:{address,family})));

test('compatible transport pins the checked address while preserving DNS hostname TLS and HTTP identity',async()=>{
  for(const address of ['8.8.8.8','2606:4700:4700::1111']){
    let lookups=0;const records=[{address}];
    const fake=fakeHTTPS({payload:'data: {"choices":[{"delta":{"content":"已固定"}}]}\n\ndata: [DONE]\n\n',beforeReply:()=>{records[0].address='127.0.0.1';}});
    const registry=new ProviderRegistry({lookupImpl:async()=>{lookups++;return records;},httpsRequestImpl:fake.requestImpl,
      fetchImpl:()=>{throw new Error('compatible traffic must not use an independently resolving fetch');}});
    const p=await registry.addCompatible({name:'Fake',baseUrl:'https://api.example.com/v1',apiKey:'test-secret',models:['m']});
    assert.equal(await collect(registry.stream({providerId:p.id,model:'m',history,name:'Test'})),'已固定');
    assert.equal(lookups,2);assert.equal(fake.calls.length,1);
    const {options,body}=fake.calls[0];const family=address.includes(':')?6:4;
    assert.deepEqual(await lookupFrom(options),{address,family});
    assert.deepEqual(await lookupFrom(options,true),[{address,family}]);
    await assert.rejects(new Promise((resolve,reject)=>options.lookup('different.example',{},error=>error?reject(error):resolve())),/HTTPS/);
    assert.equal(lookups,2);assert.equal(options.hostname,'api.example.com');assert.equal(options.servername,'api.example.com');
    assert.equal(options.headers.Host,'api.example.com');assert.equal(options.port,443);assert.equal(options.path,'/v1/chat/completions');
    assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);assert.equal(options.method,'POST');
    assert.equal(options.checkServerIdentity('untrusted-argument',{subjectaltname:'DNS:api.example.com'}),undefined);
    assert.ok(options.checkServerIdentity('api.example.com',{subjectaltname:'DNS:wrong.example.com'}) instanceof Error);
    assert.deepEqual(JSON.parse(body).messages.at(-1),history[0]);
    assert.equal(fake.calls[0].req.destroyed,true);
  }
});

test('changed or mixed DNS answers are rejected before request creation and DNS failures stay private',async()=>{
  for(const answer of [[{address:'127.0.0.1'}],[{address:'8.8.8.8'},{address:'192.168.1.1'}],[],[{address:'2001:0db8::1'}]]){
    let lookups=0;const fake=fakeHTTPS();
    const registry=new ProviderRegistry({lookupImpl:async()=>++lookups===1?await publicDNS():answer,httpsRequestImpl:fake.requestImpl});
    const p=await registry.addCompatible({name:'Fake',baseUrl:'https://api.example.com/v1',apiKey:'test-secret',models:['m']});
    await assert.rejects(collect(registry.stream({providerId:p.id,model:'m',history,name:'Test'})),/网络/);
    assert.equal(fake.calls.length,0);
  }
  await assert.rejects(validateEndpoint('https://api.example.com',async()=>{throw new Error('test-secret');}),error=>!error.message.includes('test-secret'));
});

test('private, reserved, mapped and transition addresses cannot become connection targets',async()=>{
  for(const address of ['0.1.2.3','100.64.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1',
    '2001:0db8::1','2001:0000::1','2002:7f00:1::1','3fff::1','::ffff:8.8.8.8','64:ff9b::7f00:1']){
    assert.equal(isPublicAddress(address),false,address);
  }
  for(const url of ['https://api.example.com:8443/v1','https://api.openai.com./v1','https://chatgpt.com./v1',
    'https://localhost./v1','https://api.example.com/v1#secret','https://api.example.com/v1?key=secret']){
    await assert.rejects(validateEndpoint(url,()=>{throw new Error('URL rejection must precede DNS');}));
  }
});

test('compatible redirects and rejected responses are destroyed without following or exposing upstream diagnostics',async()=>{
  for(const status of [301,302,307,308,401,429]){
    const fake=fakeHTTPS({status,payload:'test-secret private response'});
    const operation=postPublicHTTPS('https://api.example.com/v1',{authorization:'Bearer test-secret',body:'{}',lookupImpl:publicDNS,requestImpl:fake.requestImpl});
    if(status<400)await assert.rejects(operation,/重定向/);
    else{const response=await operation;assert.equal(response.ok,false);assert.equal(response.status,status);assert.equal(response.body,null);}
    assert.equal(fake.calls.length,1);assert.equal(fake.calls[0].req.destroyed,true);assert.equal(fake.calls[0].res.destroyed,true);
  }
});

test('compatible connection and body errors are sanitized with no retry',async()=>{
  for(const failure of [{failRequest:true},{failBody:true}]){
    const fake=fakeHTTPS(failure);
    await assert.rejects((async()=>{
      const response=await postPublicHTTPS('https://api.example.com/v1',{authorization:'Bearer test-secret',body:'{}',lookupImpl:publicDNS,requestImpl:fake.requestImpl});
      await collect(readSSE(response.body));
    })(),error=>!error.message.includes('test-secret')&&!error.message.includes('private'));
    assert.equal(fake.calls.length,1);assert.equal(fake.calls[0].req.destroyed,true);
  }
});

test('cancellation during DNS cannot start a late request, and a pre-cancelled call never resolves DNS',async()=>{
  const controller=new AbortController();let resolveDNS;const fake=fakeHTTPS();
  const pending=postPublicHTTPS('https://api.example.com/v1',{signal:controller.signal,body:'{}',lookupImpl:()=>new Promise(resolve=>{resolveDNS=resolve;}),requestImpl:fake.requestImpl});
  await tick();controller.abort('test-secret abort reason');
  await assert.rejects(pending,error=>error.name==='AbortError'&&!error.message.includes('test-secret'));
  resolveDNS([{address:'8.8.8.8'}]);await tick();assert.equal(fake.calls.length,0);
  let lookups=0;
  await assert.rejects(postPublicHTTPS('https://api.example.com/v1',{signal:controller.signal,lookupImpl:()=>{lookups++;},requestImpl:fake.requestImpl}),{name:'AbortError'});
  assert.equal(lookups,0);
});

test('cancellation interrupts an idle response body and closing SSE after DONE destroys the request',async()=>{
  const controller=new AbortController();const fake=fakeHTTPS({hold:true});
  const response=await postPublicHTTPS('https://api.example.com/v1',{signal:controller.signal,body:'{}',lookupImpl:publicDNS,requestImpl:fake.requestImpl});
  const pending=collect(readSSE(response.body,{signal:controller.signal}));
  await tick();controller.abort('test-secret abort reason');
  await assert.rejects(pending,error=>error.name==='AbortError'&&!error.message.includes('test-secret'));
  assert.equal(fake.calls[0].req.destroyed,true);assert.equal(fake.calls[0].res.destroyed,true);

  const held=fakeHTTPS({hold:true});const registry=new ProviderRegistry({lookupImpl:publicDNS,httpsRequestImpl:held.requestImpl});
  const p=await registry.addCompatible({name:'Fake',baseUrl:'https://api.example.com/v1',apiKey:'test-secret',models:['m']});
  const result=collect(registry.stream({providerId:p.id,model:'m',history,name:'Test'}));await tick();
  held.calls[0].res.write('data: [DONE]\n\n');await result;
  assert.equal(held.calls[0].req.destroyed,true);assert.equal(held.calls[0].res.destroyed,true);
});

test('cancellation or socket closure before response headers settles without sending another request',async()=>{
  const controller=new AbortController();const fake=fakeHTTPS({holdHeaders:true});
  const pending=postPublicHTTPS('https://api.example.com/v1',{signal:controller.signal,body:'{}',lookupImpl:publicDNS,requestImpl:fake.requestImpl});
  await tick();controller.abort('test-secret abort reason');
  await assert.rejects(pending,error=>error.name==='AbortError'&&!error.message.includes('test-secret'));
  assert.equal(fake.calls.length,1);assert.equal(fake.calls[0].req.destroyed,true);
  const closed=fakeHTTPS({holdHeaders:true,beforeReply:call=>call.req.emit('close')});
  await assert.rejects(postPublicHTTPS('https://api.example.com/v1',{body:'{}',lookupImpl:publicDNS,requestImpl:closed.requestImpl}),/HTTPS/);
  assert.equal(closed.calls.length,1);assert.equal(closed.calls[0].req.destroyed,true);
});
