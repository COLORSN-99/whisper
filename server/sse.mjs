/** Parse SSE across arbitrary UTF-8 chunks. No dependency on SDK internals. */
export async function* readSSE(body, { signal } = {}) {
  if (!body) throw new Error('模型服务未返回流。');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let event = '';
  const consumeLine = line => {
    if (line === '') {
      if (!data.length) { event = ''; return null; }
      const result = { event, data: data.join('\n') };
      data = []; event = ''; return result;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    return null;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('模型事件超过本地大小限制。');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        const result = consumeLine(line);
        if (result) yield result;
      }
      if (done) {
        if (buffer) consumeLine(buffer.replace(/\r$/, ''));
        const result = consumeLine('');
        if (result) yield result;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
