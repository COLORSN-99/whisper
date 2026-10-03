package io.github.colorsn99.whisper;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Process-local session; construction has no network or credential reads. No Activity is retained. */
final class ChatGptSession implements AutoCloseable {
    static final String ID = "chatgpt-oauth-v1";
    interface Storage {
        String host() throws Exception;
        String registration();
        String subjectHash();
        void registration(String client, String subjectHash) throws Exception;
        void save(String json) throws Exception;
        String restore() throws Exception;
        void clear() throws Exception;
        boolean saved();
    }
    private final Storage storage;
    private final Call.Factory transport;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong epoch = new AtomicLong();
    private final Object activationLock = new Object();
    private volatile OAuthLoopback loop;
    volatile boolean busy, connected, authorizing;
    volatile String status = "尚未登录 ChatGPT";
    volatile JSONArray models = new JSONArray();
    private JSONObject record;
    private boolean persistent;
    private JSONObject discovery;

    ChatGptSession(Context context, CredentialStore credentials) {
        this(new Storage() {
            final android.content.SharedPreferences meta = context.getSharedPreferences("chatgpt-registration-v1", Context.MODE_PRIVATE);
            @Override public String host() throws Exception {
                String id = meta.getString("host", null);
                if (id == null) {
                    id = "urn:uuid:" + UUID.randomUUID();
                    if (!meta.edit().putString("host", id).commit()) throw OAuthProtocol.failure();
                }
                if (!id.matches("urn:uuid:[0-9a-f-]{36}")) throw OAuthProtocol.failure();
                return id;
            }
            @Override public String registration() { return meta.getString("client", ""); }
            @Override public String subjectHash() { return meta.getString("subjectHash", ""); }
            @Override public void registration(String client, String hash) throws Exception {
                if (!meta.edit().putString("client", client).putString("subjectHash", hash).commit()) throw OAuthProtocol.failure();
            }
            @Override public void save(String json) throws Exception { credentials.put(ID, json, true); }
            @Override public String restore() throws Exception { return credentials.restore(ID, true); }
            @Override public void clear() throws Exception { credentials.remove(ID); }
            @Override public boolean saved() { return credentials.hasPersisted(ID); }
        }, ChatClient.secureHttpClient(InetAddress::getAllByName).newBuilder().callTimeout(30, TimeUnit.SECONDS).build());
    }
    ChatGptSession(Storage storage, Call.Factory transport) { this.storage = storage; this.transport = transport; }
    boolean hasSaved() { return storage.saved(); }
    void execute(Runnable action) { worker.execute(action); }

    synchronized String begin(boolean consent, boolean persist) throws Exception {
        if (!consent || busy || connected || storage.saved()) throw new IOException("请先退出当前登录，或恢复／清除已保存的会话。");
        long attempt = epoch.incrementAndGet();
        String state = OAuthProtocol.random(), nonce = OAuthProtocol.random(), verifier = OAuthProtocol.random();
        String selected = storage.registration();
        if (!selected.isEmpty() && !OAuthProtocol.clientId(selected)) throw OAuthProtocol.failure();
        String host = storage.host();
        OAuthLoopback listener = new OAuthLoopback(); loop = listener;
        String redirect = listener.redirect();
        Map<String, String> fields = OAuthProtocol.fields("response_type", "code", "client_id", selected.isEmpty() ? "dynamic_agent_client" : selected,
                "redirect_uri", redirect, "scope", OAuthProtocol.SCOPES, "resource", OAuthProtocol.RESOURCE,
                "state", state, "nonce", nonce, "code_challenge", OAuthProtocol.b64(OAuthProtocol.digest(verifier)), "code_challenge_method", "S256",
                "ext_agent_host_id", host, "agent_name_hint", "whisper");
        String url = OAuthProtocol.ISSUER + "/api/accounts/authorize?" + OAuthProtocol.form(fields);
        AtomicBoolean consumed = new AtomicBoolean();
        persistent = persist; busy = true; authorizing = true; status = "等待 Chrome 授权 · 完成后切回 whisper";
        listener.listen(values -> {
            if (epoch.get() != attempt || !OAuthProtocol.equal(state, values.get("state")) || !consumed.compareAndSet(false, true)) return false;
            execute(() -> finishLogin(attempt, selected, nonce, verifier, redirect, values));
            return true;
        }, () -> { if (epoch.compareAndSet(attempt, attempt + 1)) { busy = false; authorizing = false; status = "登录等待已超时，请重新登录"; } });
        return url;
    }
    void cancel() {
        synchronized (activationLock) {
            epoch.incrementAndGet(); OAuthLoopback listener = loop; if (listener != null) listener.close();
            busy = false; authorizing = false; status = connected ? status : "已取消登录";
        }
    }
    private synchronized void finishLogin(long attempt, String selected, String nonce, String verifier, String redirect, Map<String, String> values) {
        try {
            if (epoch.get() != attempt) return;
            if (values.containsKey("iss") && !OAuthProtocol.ISSUER.equals(values.get("iss"))) throw OAuthProtocol.failure();
            if (values.containsKey("error")) throw new IOException("你未完成 ChatGPT 授权，可重新登录。");
            String client = selected.isEmpty() ? values.get("client_id") : selected;
            if (!OAuthProtocol.clientId(client) || (values.containsKey("client_id") && !client.equals(values.get("client_id")))) throw OAuthProtocol.failure();
            String code = values.get("code");
            if (code == null || code.isEmpty() || code.length() > 8192) throw OAuthProtocol.failure();
            status = "正在校验 ChatGPT 授权";
            JSONObject tokens = token(OAuthProtocol.fields("grant_type", "authorization_code", "client_id", client,
                    "code", code, "code_verifier", verifier, "redirect_uri", redirect, "resource", OAuthProtocol.RESOURCE));
            JSONObject next = build(tokens, client, nonce, null);
            JSONObject identity = identity(next, false);
            String hash = OAuthProtocol.b64(OAuthProtocol.digest(identity.getString("sub")));
            if (!selected.isEmpty() && !hash.equals(storage.subjectHash())) throw OAuthProtocol.failure();
            next.put("subjectHash", hash).put("validated", true);
            if (epoch.get() != attempt) return;
            storage.registration(client, hash);
            if (persistent) storage.save(next.toString());
            // Cancellation can race a slow disk commit. Never activate such a session.
            boolean canceled;
            synchronized (activationLock) {
                canceled = epoch.get() != attempt;
                if (!canceled) {
                    record = next; connected = true; authorizing = false;
                    status = "ChatGPT 已登录 · " + (persistent ? "已加密保存" : "仅本次使用") + " · 点击读取模型";
                }
            }
            if (canceled) storage.clear();
        } catch (Exception failure) {
            if (epoch.get() == attempt) { connected = false; record = null; status = safe(failure, "登录未完成，请检查网络、账号资格或重新登录。"); }
        } finally { if (epoch.get() == attempt) { busy = false; authorizing = false; } }
    }
    private JSONObject config() throws Exception {
        if (discovery == null) {
            JSONObject found = get(OAuthProtocol.ISSUER + "/.well-known/openid-configuration", null);
            if (!OAuthProtocol.ISSUER.equals(found.optString("issuer"))) throw OAuthProtocol.failure();
            OAuthProtocol.endpoint(found.getString("token_endpoint"));
            OAuthProtocol.endpoint(found.getString("jwks_uri"));
            OAuthProtocol.endpoint(found.getString("revocation_endpoint"));
            discovery = found;
        }
        return discovery;
    }
    private JSONObject token(Map<String, String> fields) throws Exception {
        return jsonRequest(new Request.Builder().url(OAuthProtocol.endpoint(config().getString("token_endpoint")))
                .post(formBody(fields)).build());
    }
    private static RequestBody formBody(Map<String, String> fields) throws Exception {
        byte[] bytes = OAuthProtocol.form(fields).getBytes(StandardCharsets.UTF_8);
        RequestBody body = RequestBody.create(bytes, MediaType.get("application/x-www-form-urlencoded"));
        return new RequestBody() {
            @Override public MediaType contentType() { return body.contentType(); }
            @Override public long contentLength() { return bytes.length; }
            @Override public boolean isOneShot() { return true; }
            @Override public void writeTo(okio.BufferedSink sink) throws IOException { sink.write(bytes); }
        };
    }
    private JSONObject identity(JSONObject next, boolean refreshing) throws Exception {
        JSONArray keys = get(OAuthProtocol.endpoint(config().getString("jwks_uri")), null).getJSONArray("keys");
        return OAuthProtocol.verify(next.getString("id_token"), keys, next.getString("client_id"), next.getString("nonce"),
                next.getString("access_token"), refreshing, System.currentTimeMillis() / 1000);
    }
    static JSONObject build(JSONObject tokens, String client, String nonce, JSONObject previous) throws Exception {
        String access = OAuthProtocol.text(tokens, "access_token", 24000);
        if (!access.matches("[\\x21-\\x7e]+") || !"bearer".equalsIgnoreCase(tokens.optString("token_type"))) throw OAuthProtocol.failure();
        long expires = OAuthProtocol.integer(tokens, "expires_in");
        if (expires < 1 || expires > 31536000) throw OAuthProtocol.failure();
        String scope = tokens.has("scope") ? OAuthProtocol.text(tokens, "scope", 4096) : previous == null ? "" : previous.getString("scope");
        java.util.List<String> scopes = java.util.Arrays.asList(scope.split("\\s+"));
        if (!scopes.contains("resource.invoke") || !scopes.contains("chatgpt.tokens.use.direct")) throw new IOException("未获得 ChatGPT 订阅用量权限，请重新登录并在官方页面确认授权。");
        String refresh = tokens.has("refresh_token") ? OAuthProtocol.text(tokens, "refresh_token", 24000) : previous == null ? "" : previous.getString("refresh_token");
        if (refresh.isEmpty()) throw OAuthProtocol.failure();
        String id = tokens.has("id_token") ? OAuthProtocol.text(tokens, "id_token", 24000) : previous == null ? "" : previous.getString("id_token");
        if (id.isEmpty()) throw OAuthProtocol.failure();
        return new JSONObject().put("client_id", client).put("nonce", nonce).put("access_token", access).put("refresh_token", refresh)
                .put("id_token", id).put("scope", scope).put("expires", System.currentTimeMillis() + expires * 1000).put("validated", false);
    }
    synchronized String accessToken() throws Exception {
        if (!connected || record == null) throw new IOException("请先登录 ChatGPT。");
        if (record.getLong("expires") > System.currentTimeMillis() + 60000) return record.getString("access_token");
        JSONObject previous = record;
        // No automatic retry: even an uncertain transport failure might have rotated the token.
        try {
            JSONObject tokens = token(OAuthProtocol.fields("grant_type", "refresh_token", "client_id", previous.getString("client_id"),
                    "refresh_token", previous.getString("refresh_token"), "resource", OAuthProtocol.RESOURCE));
            JSONObject next = build(tokens, previous.getString("client_id"), previous.getString("nonce"), previous);
            next.put("subjectHash", previous.getString("subjectHash"));
            if (persistent) storage.save(next.toString()); // Mark unverified before any further network request.
            if (tokens.has("id_token")) {
                JSONObject claims = identity(next, true);
                if (!previous.getString("subjectHash").equals(OAuthProtocol.b64(OAuthProtocol.digest(claims.getString("sub"))))) throw OAuthProtocol.failure();
            }
            next.put("validated", true);
            if (persistent) storage.save(next.toString());
            record = next;
            return next.getString("access_token");
        } catch (Exception failure) {
            connected = false; record = null; models = new JSONArray();
            try { storage.clear(); } catch (Exception ignored) { }
            status = "续期未确认，已停止使用；请退出并重新登录";
            throw new IOException(status);
        }
    }
    synchronized void restore(boolean consent) {
        if (!consent || busy || connected) return;
        busy = true;
        try {
            String raw = storage.restore();
            if (raw == null) throw OAuthProtocol.failure();
            JSONObject saved = OAuthProtocol.json(raw);
            if (!saved.optBoolean("validated") || !storage.registration().equals(saved.optString("client_id"))
                    || !storage.subjectHash().equals(saved.optString("subjectHash"))) throw OAuthProtocol.failure();
            // Authenticated encrypted storage is the trust boundary. Force refresh now,
            // regardless of saved access expiry; restoration never silently consumes inference.
            record = saved; record.put("expires", 0); persistent = true; connected = true;
            accessToken(); status = "ChatGPT 会话已恢复 · 点击读取模型";
        } catch (Exception failure) { record = null; connected = false; status = "未能恢复会话，请清除保存的登录后重新授权"; }
        finally { busy = false; }
    }
    synchronized void loadModels() {
        if (busy) return;
        busy = true;
        try {
            JSONObject result = get(OAuthProtocol.RESOURCE + "/models", accessToken());
            JSONArray found = result.getJSONArray("models"), allowed = new JSONArray();
            if (found.length() > 1000) throw OAuthProtocol.failure();
            for (int i = 0; i < found.length(); i++) {
                JSONObject model = found.getJSONObject(i); String slug = model.optString("slug");
                if ("list".equals(model.optString("visibility")) && slug.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")) allowed.put(slug);
            }
            models = allowed;
            status = allowed.length() == 0 ? "已登录；账号未返回可用模型" : "ChatGPT 已就绪 · " + allowed.length() + " 个模型 · " + (persistent ? "加密保存" : "仅本次使用");
        } catch (Exception failure) { models = new JSONArray(); status = safe(failure, "无法读取 ChatGPT 模型；请检查网络、授权范围和账号资格。"); }
        finally { busy = false; }
    }
    boolean hasModel(String model) { JSONArray snapshot = models; for (int i = 0; i < snapshot.length(); i++) if (model.equals(snapshot.optString(i))) return true; return false; }
    synchronized void logout() {
        cancel(); busy = true; connected = false; models = new JSONArray();
        JSONObject previous = record; record = null;
        boolean revoked = previous == null && !storage.saved(), cleared = false;
        try {
            if (previous != null) {
                Request request = new Request.Builder().url(OAuthProtocol.endpoint(config().getString("revocation_endpoint")))
                        .post(formBody(OAuthProtocol.fields("token", previous.getString("refresh_token"), "token_type_hint", "refresh_token", "client_id", previous.getString("client_id")))).build();
                try (Response response = transport.newCall(request).execute()) { revoked = response.isSuccessful(); }
            }
        } catch (Exception ignored) { }
        finally {
            try { storage.clear(); cleared = true; } catch (Exception ignored) { }
            persistent = false; busy = false;
            status = !cleared ? "已停止使用，但本机保存未能清除；请在系统设置清除应用数据，并在 ChatGPT 设置断开授权"
                    : revoked ? "已退出并清除登录" : "本机登录已清除；远程撤销未确认，请在 ChatGPT 设置断开 whisper";
        }
    }
    private JSONObject get(String url, String access) throws Exception {
        Request.Builder request = new Request.Builder().url(url).header("Accept", "application/json");
        if (access != null) request.header("Authorization", "Bearer " + access);
        return jsonRequest(request.build());
    }
    private JSONObject jsonRequest(Request request) throws Exception {
        try (Response response = transport.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("ChatGPT 请求未完成（HTTP " + response.code() + "）；请检查网络或重新授权。");
            if (response.body() == null) throw OAuthProtocol.failure();
            byte[] bytes = LocalStore.readBounded(response.body().byteStream(), 256 * 1024);
            return OAuthProtocol.json(new String(bytes, StandardCharsets.UTF_8));
        }
    }
    @Override public void close() { cancel(); worker.shutdownNow(); record = null; connected = false; }

    static String safe(Exception error, String fallback) {
        // Only our bounded messages may reach the UI, never response bodies/URLs/library errors.
        String message = error.getMessage();
        if (error.getClass() == IOException.class && message != null && (message.startsWith("ChatGPT ")
                || message.startsWith("未获得 ChatGPT") || message.startsWith("你未完成 ChatGPT"))) return message;
        return fallback;
    }
}
