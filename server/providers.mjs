import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readSSE } from './sse.mjs';
import { validateEndpoint, postPublicHTTPS } from './public-https.mjs';
export { validateEndpoint, isPublicAddress } from './public-https.mjs';

const DEMO_MODELS = [
  { id: 'demo-guide', name: '向导 · 测试适配器' },
  { id: 'demo-builder', name: '构建者 · 测试适配器' },
  { id: 'demo-reviewer', name: '审阅者 · 测试适配器' },
];

function statusError(status) {
  if (status === 401 || status === 403) return new Error('模型服务拒绝授权，请重新登录或检查该模型的权限。');
  if (status === 429) return new Error('当前模型额度或速率达到限制，请稍后重试并在官方页面管理额度。');
  return new Error(`模型请求失败（HTTP ${status}）。未自动重试，以免重复消耗额度。`);
}

export class ProviderRegistry {
  constructor({ getAccessToken, fetchImpl = fetch, lookupImpl = lookup, httpsRequestImpl, demoDelay = 22 } = {}) {
    this.getAccessToken = getAccessToken;
    this.fetch = fetchImpl; this.lookup = lookupImpl; this.httpsRequest = httpsRequestImpl; this.demoDelay = demoDelay;
    this.compatible = new Map(); this.chatgptModels = [];
  }
  list(auth = {}) {
    return [
      {id:'demo',label:'演示模式',kind:'demo',connected:true,models:DEMO_MODELS},
      {id:'chatgpt',label:'ChatGPT 计划',kind:'chatgpt',connected:!!auth.connected && !!auth.planEnabled,models:this.chatgptModels},
      ...[...this.compatible.values()].map(({secret, ...p}) => p),
    ];
  }
  async addCompatible({name, baseUrl, apiKey, models}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 50 ||
        typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 ||
        !Array.isArray(models) || !models.length || models.length > 20 ||
        models.some(x => typeof x !== 'string' || !x.trim() || x.length > 150)) throw new Error('供应商名称、凭据与模型列表不完整。');
    const endpoint = await validateEndpoint(baseUrl, this.lookup);
    const id = `compatible-${randomUUID()}`;
    const p = {id,label:name.trim(),kind:'compatible',connected:true,baseUrl:endpoint,
      models:[...new Set(models.map(x => x.trim()))].map(id => ({id,name:id})),secret:apiKey.trim()};
    this.compatible.set(id,p);
    const {secret,...safe} = p; return safe;
  }
  remove(id) { this.compatible.delete(id); }
  clearChatGPT() { this.chatgptModels = []; }
  async models(providerId) {
    if (providerId !== 'chatgpt') return this.list().find(x => x.id === providerId)?.models || [];
    const token = await this.getAccessToken();
    const response = await this.fetch('https://api.openai.com/v1/models', {
      headers:{Authorization:`Bearer ${token}`}, redirect:'error', signal:AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw statusError(response.status);
    const result = await response.json();
    if (!Array.isArray(result.models)) throw new Error('ChatGPT 模型目录格式不受支持。');
    this.chatgptModels = result.models.filter(x => x.visibility === 'list' && typeof x.slug === 'string')
      .map(x => ({id:x.slug,name:x.display_name || x.slug}));
    return this.chatgptModels;
  }
  hasModel(providerId, model) { return this.list({connected:true,planEnabled:true}).find(x=>x.id===providerId)?.models.some(x=>x.id===model); }
  async *stream({providerId,model,history,name,signal}) {
    if (!this.hasModel(providerId,model)) throw new Error('请选择当前供应商目录中的模型；登录后先刷新模型列表。');
    if (providerId === 'demo') {
      const prompt = [...history].reverse().find(x=>x.role==='user')?.content || '';
      const angle = model === 'demo-builder' ? '先把需求变成一个小而可验证的步骤，再逐步补齐。' : model === 'demo-reviewer' ?
        '先确认边界与失败处理：访问什么、如何撤销、何时需要你作决定。' : '我会先梳理目标，再把需要你决定的事情放到对话里。';
      const text = `【测试适配器 · 未调用真实模型】\n${name}收到：“${prompt.slice(0,180)}”\n\n${angle}\n\n你可以继续和不同角色聊天，也可以创建一个演示任务，体验进度与审批。连接 ChatGPT 后，选择账户实际提供的模型即可开始真实对话。`;
      for (const part of text.match(/.{1,5}|\n/gu) || []) {
        signal?.throwIfAborted(); await delay(this.demoDelay, undefined, {signal}); yield part;
      }
      return;
    }
    const combined = signal ? AbortSignal.any([signal,AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
    const instructions = `你是用户在Whisper中配置的助手，显示名称为 ${name}。用中文回答，除非用户要求其他语言。对话可能有多位助手，引用其他助手意见时标明来源。聊天模式没有电脑执行权限，不要声称已执行工具或操作设备。`;
    const input = history.map(m => ({role:m.role,content:m.role==='assistant' && m.name ? `[${m.name}] ${m.content}` : m.content}));
    let url, headers, body;
    if (providerId === 'chatgpt') {
      url = 'https://api.openai.com/v1/responses';
      headers = {Authorization:`Bearer ${await this.getAccessToken()}`,'Content-Type':'application/json'};
      body = {model,instructions,input,store:false,stream:true};
    } else {
      const provider = this.compatible.get(providerId);
      if (!provider) throw new Error('该供应商的内存凭据已清除，请重新连接。');
      url = `${provider.baseUrl}/chat/completions`;
      headers = {Authorization:`Bearer ${provider.secret}`,'Content-Type':'application/json'};
      body = {model,messages:[{role:'system',content:instructions},...input],stream:true};
    }
    const response = providerId === 'chatgpt'
      ? await this.fetch(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:combined})
      : await postPublicHTTPS(url,{authorization:headers.Authorization,body:JSON.stringify(body),signal:combined,
        lookupImpl:this.lookup,requestImpl:this.httpsRequest});
    if (!response.ok) throw statusError(response.status);
    let completed = false;
    for await (const event of readSSE(response.body,{signal:combined})) {
      if (event.data === '[DONE]') { if (providerId !== 'chatgpt') completed=true; break; }
      let item;
      try { item=JSON.parse(event.data); } catch { throw new Error('模型服务返回了无效的流事件。'); }
      if (providerId === 'chatgpt') {
        if (item.type === 'response.output_text.delta' && typeof item.delta === 'string') yield item.delta;
        if (item.type === 'response.completed') { completed=true; break; }
        if (['response.failed','response.incomplete','error'].includes(item.type)) throw new Error('模型未完成本次回复，请检查额度或调整输入。');
      } else {
        if (item.error) throw new Error('供应商中断了本次回复。');
        const choice = item.choices?.[0];
        if (typeof choice?.delta?.content === 'string') yield choice.delta.content;
        if (choice?.finish_reason === 'stop') completed=true;
        else if (choice?.finish_reason) throw new Error('供应商回复未完整结束，可能触发长度限制或工具调用。');
      }
    }
    if (!completed) throw new Error('连接中断，未收到模型完成事件。已有内容已保留。');
  }
}
