package io.github.colorsn99.whisper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.Dns;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSink;

/**
 * One cancellable third-party chat-completions stream at a time.
 * This class owns its background executor. All listener callbacks are on that
 * executor; an Activity must marshal UI changes with runOnUiThread().
 * ChatGPT uses a separate verified OAuth session and Responses protocol. No API-key fallback, tools, redirects, or retries.
 */
public final class ChatClient implements AutoCloseable {
    private static final int MAX_REQUEST_BYTES = 1024 * 1024;
    private static final int MAX_STREAM_BYTES = 4 * 1024 * 1024;
    private static final int MAX_EVENT_CHARS = 1024 * 1024;
    private static final int MAX_LINE_CHARS = 512 * 1024;
    private static final int MAX_TEXT_CHARS = 128 * 1024;
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    public interface Listener {
        void onDelta(String text);
        void onComplete();
        void onError(String safeMessage);
    }

    public interface Request {
        void cancel();
        boolean isCancelled();
    }

    interface Resolver { InetAddress[] resolve(String host) throws UnknownHostException; }

    private final OkHttpClient http;
    private final Call.Factory transport;
    private final ExecutorService executor;
    private RunningRequest active;
    private boolean closed;

    public ChatClient() {
        this.http = secureHttpClient(InetAddress::getAllByName);
        this.transport = http;
        this.executor = newExecutor();
    }

    // Package-private fake-transport seam: tests never need a live API or token.
    ChatClient(Call.Factory transport, ExecutorService executor) {
        this.http = null;
        this.transport = transport;
        this.executor = executor;
    }

    private static ExecutorService newExecutor() {
        return Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "whisper-chat");
            thread.setDaemon(true);
            return thread;
        });
    }

    static OkHttpClient secureHttpClient(Resolver resolver) {
        return new OkHttpClient.Builder()
                // OkHttp connects using these exact resolved InetAddresses. A
                // separate preflight followed by default DNS would be unsafe.
                .dns(publicDns(resolver))
                .proxy(Proxy.NO_PROXY)
                .cookieJar(CookieJar.NO_COOKIES)
                .cache(null)
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .callTimeout(5, TimeUnit.MINUTES)
                // Platform trust and original-hostname verification are retained.
                .build();
    }

    static Dns publicDns(Resolver resolver) {
        return hostname -> {
            InetAddress[] addresses;
            try { addresses = resolver.resolve(hostname); }
            catch (UnknownHostException failure) { throw new UnknownHostException("无法解析厂商公网地址。"); }
            if (addresses == null || addresses.length == 0 || addresses.length > 32)
                throw new UnknownHostException("厂商地址没有可用的公网解析结果。");
            for (InetAddress address : addresses) {
                if (!isPublicAddress(address))
                    throw new UnknownHostException("厂商地址解析到了非公网网络，已拒绝连接。");
            }
            return Collections.unmodifiableList(new ArrayList<>(Arrays.asList(addresses)));
        };
    }

    /** Rejects local, special-purpose, documentation, multicast and tunnel ranges. */
    static boolean isPublicAddress(InetAddress address) {
        if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress()
                || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int a = bytes[0] & 255, b = bytes[1] & 255, c = bytes[2] & 255;
            return !(a == 0 || a == 10 || a == 127 || a >= 224
                    || (a == 100 && b >= 64 && b <= 127)
                    || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31)
                    || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                    || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                    || (a == 203 && b == 0 && c == 113));
        }
        if (bytes.length != 16) return false;
        int a = bytes[0] & 255, b = bytes[1] & 255, c = bytes[2] & 255, d = bytes[3] & 255;
        // Only global unicast 2000::/3, excluding special-purpose / documentation
        // allocations and 6to4. This also excludes mapped, local and NAT64 forms.
        if ((a & 0xe0) != 0x20) return false;
        if (a == 0x20 && b == 0x01 && (c < 2 || (c == 0x0d && d == 0xb8))) return false;
        if (a == 0x20 && b == 0x02) return false;
        return !(a == 0x3f && b == 0xff);
    }

    /** Pure validation; no DNS lookup, credential use or network request. */
    public static String validateEndpoint(String supplied) {
        if (supplied == null || supplied.length() > 2048 || !supplied.equals(supplied.trim()))
            throw new IllegalArgumentException("请输入第三方厂商的公网 HTTPS 地址。");
        final URI input;
        try { input = new URI(supplied); }
        catch (URISyntaxException failure) { throw new IllegalArgumentException("厂商地址格式无效。"); }
        String host = input.getHost();
        if (!"https".equalsIgnoreCase(input.getScheme()) || host == null || input.getRawUserInfo() != null
                || input.getRawQuery() != null || input.getRawFragment() != null
                || (input.getPort() != -1 && input.getPort() != 443))
            throw new IllegalArgumentException("只支持 HTTPS 443 公网域名；地址不能包含账号、查询参数或片段。");
        host = host.toLowerCase(Locale.ROOT);
        if (host.length() > 253 || host.endsWith(".") || !host.contains(".")
                || !host.matches("[a-z0-9-]+(?:\\.[a-z0-9-]+)+") || host.matches("[0-9.]+"))
            throw new IllegalArgumentException("厂商地址必须使用公网域名，不能使用 IP 或本地名称。");
        for (String label : host.split("\\.")) {
            if (label.length() > 63 || label.startsWith("-") || label.endsWith("-"))
                throw new IllegalArgumentException("厂商域名格式无效。");
        }
        for (String suffix : new String[]{"localhost", "local", "localdomain", "internal", "lan", "home", "test", "invalid", "example", "onion"}) {
            if (host.equals(suffix) || host.endsWith("." + suffix))
                throw new IllegalArgumentException("不允许连接本机、私网或保留域名。");
        }
        if (host.equals("openai.com") || host.endsWith(".openai.com")
                || host.equals("chatgpt.com") || host.endsWith(".chatgpt.com")
                || host.equals("openai.azure.com") || host.endsWith(".openai.azure.com"))
            throw new IllegalArgumentException("ChatGPT 请使用设置中的官方登录，不能用 OpenAI API key 替代。此处仅配置其他厂商。");
        String path = input.getRawPath();
        if (path == null || path.isEmpty()) path = "/v1";
        if (path.contains("%") || path.contains("\\") || path.contains("//") || !Objects.equals(input.normalize().getRawPath(), input.getRawPath()))
            throw new IllegalArgumentException("厂商路径不能包含编码字符或路径跳转。");
        while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (path.isEmpty()) path = "/v1";
        if (!path.endsWith("/chat/completions")) path += "/chat/completions";
        return "https://" + host + path;
    }

    static byte[] requestBody(String model, JSONArray source) throws SafeFailure {
        if (model == null || !model.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}"))
            throw new SafeFailure("模型名称无效，请检查厂商配置。");
        if (source == null || source.length() == 0 || source.length() > 500)
            throw new SafeFailure("会话历史为空或过长，请创建新会话。");
        try {
            JSONArray messages = new JSONArray();
            for (int i = 0; i < source.length(); i++) {
                JSONObject entry = source.getJSONObject(i);
                String role = entry.getString("role"), content = entry.getString("content");
                if (!Arrays.asList("system", "user", "assistant").contains(role)
                        || content.length() > MAX_TEXT_CHARS || !wellFormed(content))
                    throw new SafeFailure("会话消息格式无效或过长。");
                messages.put(new JSONObject().put("role", role).put("content", content));
            }
            byte[] bytes = new JSONObject().put("model", model).put("messages", messages)
                    .put("stream", true).toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_REQUEST_BYTES) throw new SafeFailure("会话上下文超过 1 MiB，请创建新会话。");
            return bytes;
        } catch (JSONException failure) { throw new SafeFailure("会话消息格式无效。"); }
    }

    // retryOnConnectionFailure(false) alone does not stop OkHttp's HTTP 503
    // Retry-After: 0 follow-up. A potentially billed POST is never replayable.
    static RequestBody oneShotBody(byte[] bytes) {
        RequestBody delegate = RequestBody.create(bytes, JSON);
        return new RequestBody() {
            @Override public MediaType contentType() { return delegate.contentType(); }
            @Override public long contentLength() throws IOException { return delegate.contentLength(); }
            @Override public void writeTo(BufferedSink sink) throws IOException { delegate.writeTo(sink); }
            @Override public boolean isOneShot() { return true; }
        };
    }

    /** One active request per client; UI should cancel it before starting another. */
    public synchronized Request stream(String endpoint, String secret, String model, JSONArray messages, Listener listener) {
        if (closed) throw new IllegalStateException("聊天客户端已关闭。");
        if (active != null) throw new IllegalStateException("已有回复正在生成，请先停止或等待。");
        if (listener == null) throw new IllegalArgumentException("缺少消息监听器。");
        // Snapshot UI-owned JSON immediately; no caller mutation reaches the request.
        String snapshot = messages == null ? "null" : messages.toString();
        RunningRequest request = new RunningRequest(endpoint, secret, model, snapshot, listener);
        active = request;
        executor.execute(request);
        return request;
    }

    public synchronized Request streamChatGpt(ChatGptSession session, String model, JSONArray messages, Listener listener) {
        if (closed || active != null) throw new IllegalStateException("已有请求或客户端已关闭。");
        RunningRequest request = new RunningRequest(null, null, model, messages.toString(), listener);
        request.session = session;
        active = request;
        executor.execute(request);
        return request;
    }

    static byte[] responsesBody(String model, JSONArray source) throws Exception {
        // Reuse strict message/model/size validation, then adapt to Responses input.
        JSONObject validated = new JSONObject(new String(requestBody(model, source), StandardCharsets.UTF_8));
        JSONArray input = new JSONArray();
        StringBuilder instructions = new StringBuilder();
        JSONArray messages = validated.getJSONArray("messages");
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.getJSONObject(i);
            if ("system".equals(message.getString("role"))) instructions.append(message.getString("content")).append('\n');
            else input.put(message);
        }
        return new JSONObject().put("model", model).put("instructions", instructions.toString()).put("input", input)
                .put("store", false).put("stream", true).toString().getBytes(StandardCharsets.UTF_8);
    }

    private final class RunningRequest implements Request, Runnable {
        final String endpoint, model, messages;
        String secret;
        ChatGptSession session;
        final Listener listener;
        final AtomicBoolean cancelled = new AtomicBoolean();
        final AtomicBoolean terminal = new AtomicBoolean();
        volatile Call call;

        RunningRequest(String endpoint, String secret, String model, String messages, Listener listener) {
            this.endpoint = endpoint; this.secret = secret; this.model = model; this.messages = messages; this.listener = listener;
        }

        @Override public void cancel() { if (!terminal.get()) { cancelled.set(true); Call current = call; if (current != null) current.cancel(); } }
        @Override public boolean isCancelled() { return cancelled.get(); }

        @Override public void run() {
            String problem = null;
            try {
                checkCancelled(cancelled);
                String url;
                byte[] body;
                if (session != null) {
                    if (!session.hasModel(model)) throw new SafeFailure("请先读取并选择当前 ChatGPT 账号的可用模型。");
                    secret = session.accessToken();
                    checkCancelled(cancelled);
                    url = OAuthProtocol.RESOURCE + "/responses";
                    body = responsesBody(model, new JSONArray(messages));
                } else {
                    try { url = validateEndpoint(endpoint); }
                    catch (IllegalArgumentException failure) { throw new SafeFailure(failure.getMessage()); }
                    if (secret == null || secret.length() < 1 || secret.length() > 8192 || !secret.matches("[\\x21-\\x7e]+"))
                        throw new SafeFailure("请配置当前厂商的有效凭据；凭据不能包含空白或控制字符。");
                    if (secret.startsWith("sk-proj-") || secret.startsWith("sk-svcacct-"))
                        throw new SafeFailure("此入口不接收 OpenAI Platform 密钥；请使用 ChatGPT 官方登录。");
                    body = requestBody(model, new JSONArray(messages));
                }
                okhttp3.Request request = new okhttp3.Request.Builder().url(url)
                        .header("Authorization", "Bearer " + secret)
                        .header("Accept", "text/event-stream")
                        .post(oneShotBody(body)).build();
                call = transport.newCall(request);
                if (cancelled.get()) call.cancel();
                checkCancelled(cancelled);
                try (Response response = call.execute()) {
                    checkCancelled(cancelled);
                    if (response.code() >= 300 && response.code() < 400)
                        throw new SafeFailure("厂商返回重定向，已停止；请检查并直接填写最终 API 地址。");
                    if (!response.isSuccessful())
                        throw new SafeFailure("厂商请求失败（HTTP " + response.code() + "）；没有自动重试。请检查凭据、模型和额度。");
                    ResponseBody responseBody = response.body();
                    String contentType = response.header("Content-Type", "").toLowerCase(Locale.ROOT);
                    if (responseBody == null || !contentType.split(";", 2)[0].trim().equals("text/event-stream"))
                        throw new SafeFailure("厂商没有返回兼容的 SSE 流，请检查 API 地址。");
                    DeltaBatcher batcher = new DeltaBatcher(text -> {
                        checkCancelled(cancelled);
                        try { listener.onDelta(text); }
                        catch (RuntimeException failure) { throw new SafeFailure("界面无法接收回复，已停止请求。"); }
                    }, System::nanoTime);
                    SecretRedactor redactor = new SecretRedactor(secret, batcher::accept);
                    try { parseSse(responseBody.byteStream(), cancelled, redactor::accept, session != null); }
                    finally { try { redactor.finish(); } finally { batcher.finish(); } }
                }
                checkCancelled(cancelled);
            } catch (SafeFailure failure) { problem = failure.getMessage(); }
            catch (Exception failure) {
                problem = cancelled.get() ? "已停止生成；已收到的文字已保留。" : "连接或回复未完整结束；已收到的文字已保留，没有自动重试。";
            } finally {
                secret = null;
                call = null;
                finish(problem);
            }
        }

        private void finish(String problem) {
            if (!terminal.compareAndSet(false, true)) return;
            synchronized (ChatClient.this) { if (active == this) active = null; }
            if (cancelled.get()) problem = "已停止生成；已收到的文字已保留。";
            try { if (problem == null) listener.onComplete(); else listener.onError(problem); }
            catch (RuntimeException ignored) { /* Observers cannot restart or leak a transport exception. */ }
        }
    }

    interface DeltaSink { void emit(String text) throws IOException; }
    static final class SafeFailure extends IOException { SafeFailure(String message) { super(message); } }

    static void checkCancelled(AtomicBoolean cancelled) throws SafeFailure {
        if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new SafeFailure("已停止生成；已收到的文字已保留。");
    }

    /** SSE and chat-completions parser; never trusts EOF alone as successful completion. */
    static void parseSse(InputStream source, AtomicBoolean cancelled, DeltaSink sink) throws IOException {
        parseSse(source, cancelled, sink, false);
    }
    static void parseSse(InputStream source, AtomicBoolean cancelled, DeltaSink sink, boolean responses) throws IOException {
        InputStream limited = new FilterInputStream(source) {
            int bytes;
            private void count(int n) throws IOException { bytes += n; if (bytes > MAX_STREAM_BYTES) throw new SafeFailure("回复数据超过本地限制，已停止。"); }
            @Override public int read() throws IOException { int value = super.read(); if (value >= 0) count(1); return value; }
            @Override public int read(byte[] data, int offset, int length) throws IOException { int size = in.read(data, offset, length); if (size > 0) count(size); return size; }
        };
        BufferedReader reader = new BufferedReader(new InputStreamReader(limited, StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)));
        StringBuilder data = new StringBuilder();
        int[] totals = {0, 0}; // received choices, emitted UTF-16 characters
        boolean first = true;
        while (true) {
            checkCancelled(cancelled);
            String line = boundedLine(reader);
            if (line == null) {
                // SSE requires an empty line to dispatch an event; a truncated
                // final JSON line is not upgraded into a completed response.
                throw new SafeFailure("连接在完成标识前中断；已收到的文字已保留。");
            }
            if (first) { first = false; if (line.startsWith("\uFEFF")) line = line.substring(1); }
            if (line.isEmpty()) {
                if (data.length() > 0) {
                    if (responses ? responseEvent(data.toString(), totals, sink) : event(data.toString(), totals, sink)) return;
                    data.setLength(0);
                }
            } else if (line.startsWith("data:")) {
                String value = line.substring(5);
                if (value.startsWith(" ")) value = value.substring(1);
                if (data.length() > 0) data.append('\n');
                data.append(value);
                if (data.length() > MAX_EVENT_CHARS) throw new SafeFailure("单条模型事件过大，已停止。");
            }
        }
    }

    private static String boundedLine(BufferedReader reader) throws IOException {
        StringBuilder line = new StringBuilder();
        while (true) {
            int value = reader.read();
            if (value == -1) return line.length() == 0 ? null : line.toString();
            if (value == '\n') return line.toString();
            if (value == '\r') {
                reader.mark(1);
                int next = reader.read();
                if (next != '\n' && next != -1) reader.reset();
                return line.toString();
            }
            line.append((char) value);
            if (line.length() > MAX_LINE_CHARS) throw new SafeFailure("模型事件行过长，已停止。");
        }
    }

    private static boolean responseEvent(String data, int[] totals, DeltaSink sink) throws IOException {
        try {
            validateJsonDepth(data);
            JSONObject event = new JSONObject(data);
            String type = event.getString("type");
            if (type.equals("error") || type.equals("response.failed") || type.equals("response.incomplete"))
                throw new SafeFailure("ChatGPT 未完成本次回复，请检查额度或调整输入；没有自动重试。");
            if (type.equals("response.output_item.added")) {
                String itemType = event.getJSONObject("item").optString("type");
                if (!itemType.equals("message") && !itemType.equals("reasoning"))
                    throw new SafeFailure("当前 ChatGPT 聊天不执行工具调用。");
            }
            if (type.equals("response.output_text.delta") || type.equals("response.refusal.delta")) {
                String delta = event.getString("delta");
                if (!wellFormed(delta)) throw new SafeFailure("ChatGPT 文本格式无效。");
                totals[1] += delta.length();
                if (totals[1] > MAX_TEXT_CHARS) throw new SafeFailure("回复文字超过本地限制，已停止。");
                if (!delta.isEmpty()) sink.emit(delta);
            }
            if (type.equals("response.completed")) {
                if (!"completed".equals(event.getJSONObject("response").optString("status")) || totals[1] == 0)
                    throw new SafeFailure("ChatGPT 没有返回完整文字回复。");
                return true;
            }
            return false;
        } catch (JSONException failure) { throw new SafeFailure("ChatGPT 返回了无效的 Responses 事件。"); }
    }

    private static boolean event(String data, int[] totals, DeltaSink sink) throws IOException {
        if (data.equals("[DONE]")) {
            if (totals[0] == 0 || totals[1] == 0) throw new SafeFailure("模型没有返回有效文字回复。");
            return true;
        }
        try {
            validateJsonDepth(data);
            JSONObject event = new JSONObject(data);
            if (event.has("error")) throw new SafeFailure("厂商报告生成错误；敏感诊断未显示。");
            JSONArray choices = event.optJSONArray("choices");
            if (choices == null || choices.length() > 1) throw new SafeFailure("模型流不符合单条聊天回复格式。");
            if (choices.length() == 0) return false; // Optional usage-only event.
            JSONObject choice = choices.getJSONObject(0);
            if (choice.optInt("index", 0) != 0) throw new SafeFailure("模型返回了不支持的回复分支。");
            totals[0]++;
            JSONObject delta = choice.optJSONObject("delta");
            if (delta != null) {
                if (delta.has("tool_calls") || delta.has("function_call")) throw new SafeFailure("当前聊天入口不执行模型工具调用。");
                if (delta.has("content") && !delta.isNull("content")) {
                    Object content = delta.get("content");
                    if (!(content instanceof String) || !wellFormed((String) content)) throw new SafeFailure("模型文本格式无效。");
                    String text = (String) content;
                    totals[1] += text.length();
                    if (totals[1] > MAX_TEXT_CHARS) throw new SafeFailure("回复文字超过本地限制，已停止。");
                    if (!text.isEmpty()) sink.emit(text);
                }
            }
            if (!choice.isNull("finish_reason")) {
                String reason = choice.getString("finish_reason");
                if (reason.equals("stop")) {
                    if (totals[1] == 0) throw new SafeFailure("模型没有返回有效文字回复。");
                    return true;
                }
                if (reason.equals("length")) throw new SafeFailure("回复达到厂商长度限制；已收到的文字已保留。");
                if (reason.equals("content_filter")) throw new SafeFailure("厂商限制了本次回复；已收到的文字已保留。");
                throw new SafeFailure("厂商以不支持的方式结束回复；当前入口不执行工具调用。");
            }
            return false;
        } catch (JSONException failure) { throw new SafeFailure("模型事件不是有效的聊天 JSON。"); }
    }

    static boolean wellFormed(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) return false;
            } else if (Character.isLowSurrogate(c)) return false;
        }
        return true;
    }

    // Android JSONTokener accepts nonstandard syntax and recursively descends.
    // Shared strict syntax/depth/value-count checks run before that parser.
    static void validateJsonDepth(String json) throws SafeFailure {
        try { LocalStore.validateJsonSyntax(json); }
        catch (IOException failure) { throw new SafeFailure("模型事件 JSON 格式无效或嵌套过深，已停止。"); }
    }

    /** Redacts a credential echoed across arbitrary delta boundaries. */
    static final class SecretRedactor {
        final String secret;
        final DeltaSink sink;
        String tail = "";
        SecretRedactor(String secret, DeltaSink sink) { this.secret = secret; this.sink = sink; }
        void accept(String text) throws IOException {
            String combined = (tail + text).replace(secret, "[已隐藏凭据]");
            int held = Math.min(secret.length() - 1, combined.length());
            while (held > 0 && !combined.endsWith(secret.substring(0, held))) held--;
            tail = held == 0 ? "" : combined.substring(combined.length() - held);
            String visible = held == 0 ? combined : combined.substring(0, combined.length() - held);
            if (!visible.isEmpty()) sink.emit(visible);
        }
        void finish() throws IOException { if (!tail.isEmpty()) { tail = ""; sink.emit("[已隐藏凭据片段]"); } }
    }

    /** Prevent a fast stream of tiny events from flooding the Activity queue. */
    static final class DeltaBatcher {
        private final DeltaSink sink;
        private final LongSupplier clock;
        private final StringBuilder pending = new StringBuilder();
        private boolean started;
        private long lastFlush;
        DeltaBatcher(DeltaSink sink, LongSupplier clock) { this.sink = sink; this.clock = clock; }
        void accept(String text) throws IOException {
            pending.append(text);
            long now = clock.getAsLong();
            if (!started || pending.length() >= 2048 || now - lastFlush >= 33_000_000L) {
                finish();
                lastFlush = now;
                started = true;
            }
        }
        void finish() throws IOException {
            if (pending.length() == 0) return;
            String chunk = pending.toString();
            pending.setLength(0);
            sink.emit(chunk);
        }
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        if (active != null) active.cancel();
        // Let a request canceled before it began run its one terminal callback.
        // Active socket I/O is already interrupted by Call.cancel() above.
        executor.shutdown();
        if (http != null) {
            http.dispatcher().cancelAll();
            http.connectionPool().evictAll();
            http.dispatcher().executorService().shutdown();
        }
    }
}
