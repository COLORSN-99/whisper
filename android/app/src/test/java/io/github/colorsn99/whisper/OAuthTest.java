package io.github.colorsn99.whisper;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.Timeout;
import static org.junit.Assert.*;

/** Fake issuer, temporary RSA keys, local loopback only. No live authorization or inference. */
public class OAuthTest {
    static final String CLIENT = "test-issued-client", SUBJECT = "test-subject";
    static final KeyPair PAIR;
    static {
        try { KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); PAIR = generator.generateKeyPair(); }
        catch (Exception failure) { throw new ExceptionInInitializerError(failure); }
    }
    static JSONObject claims(String nonce) throws Exception {
        return new JSONObject().put("iss", OAuthProtocol.ISSUER).put("aud", CLIENT).put("sub", SUBJECT)
                .put("iat", System.currentTimeMillis() / 1000).put("exp", System.currentTimeMillis() / 1000 + 600).put("nonce", nonce);
    }
    static JSONObject key() throws Exception {
        RSAPublicKey publicKey = (RSAPublicKey) PAIR.getPublic();
        return new JSONObject().put("kid", "test-key").put("kty", "RSA").put("alg", "RS256")
                .put("n", OAuthProtocol.b64(publicKey.getModulus().toByteArray())).put("e", OAuthProtocol.b64(publicKey.getPublicExponent().toByteArray()));
    }
    static String jwt(JSONObject claims) throws Exception {
        String header = OAuthProtocol.b64("{\"alg\":\"RS256\",\"kid\":\"test-key\"}".getBytes(StandardCharsets.UTF_8));
        String input = header + "." + OAuthProtocol.b64(claims.toString().getBytes(StandardCharsets.UTF_8));
        Signature signature = Signature.getInstance("SHA256withRSA"); signature.initSign(PAIR.getPrivate()); signature.update(input.getBytes(StandardCharsets.US_ASCII));
        return input + "." + OAuthProtocol.b64(signature.sign());
    }
    static JSONObject verify(JSONObject claims) throws Exception {
        return OAuthProtocol.verify(jwt(claims), new JSONArray().put(key()), CLIENT, "nonce", "fake-access", false, System.currentTimeMillis() / 1000);
    }
    @Test public void signedIdentityAndAccessHashVerify() throws Exception {
        JSONObject claims = claims("nonce").put("at_hash", OAuthProtocol.b64(java.util.Arrays.copyOf(OAuthProtocol.digest("fake-access"), 16)));
        assertEquals(SUBJECT, verify(claims).getString("sub"));
    }
    @Test public void rejectsWrongIdentityBindingsAndTimes() throws Exception {
        for (String name : new String[]{"iss", "aud", "nonce", "at_hash", "azp"}) {
            JSONObject wrong = claims("nonce").put(name, "wrong");
            assertThrows(name, Exception.class, () -> verify(wrong));
        }
        assertThrows(Exception.class, () -> verify(claims("nonce").put("exp", 1)));
        assertThrows(Exception.class, () -> verify(claims("nonce").put("iat", System.currentTimeMillis() / 1000 + 100)));
        assertThrows(Exception.class, () -> verify(claims("nonce").put("nbf", System.currentTimeMillis() / 1000 + 100)));
        assertThrows(Exception.class, () -> verify(claims("nonce").put("exp", "9999999999")));
        assertThrows(Exception.class, () -> verify(claims("nonce").put("aud", new JSONArray().put(CLIENT).put("another"))));
    }
    @Test public void rejectsUnsignedTamperedAndDuplicateSigningKeys() throws Exception {
        String token = jwt(claims("nonce"));
        assertThrows(Exception.class, () -> OAuthProtocol.verify(token.substring(0, token.lastIndexOf('.') + 1) + "AAAA", new JSONArray().put(key()), CLIENT, "nonce", "fake-access", false, System.currentTimeMillis() / 1000));
        assertThrows(Exception.class, () -> OAuthProtocol.verify(token, new JSONArray().put(key()).put(key()), CLIENT, "nonce", "fake-access", false, System.currentTimeMillis() / 1000));
        assertThrows(Exception.class, () -> OAuthProtocol.verify(token, new JSONArray(), CLIENT, "nonce", "fake-access", false, System.currentTimeMillis() / 1000));
    }
    @Test public void endpointsAndCallbackQueryFailClosed() throws Exception {
        for (String endpoint : new String[]{"http://auth.openai.com/token", "https://auth.openai.com.evil.test/token", "https://user@auth.openai.com/token", "https://auth.openai.com/token?x=1", "https://auth.openai.com:443/token"})
            assertThrows(Exception.class, () -> OAuthProtocol.endpoint(endpoint));
        assertThrows(Exception.class, () -> OAuthProtocol.query("state=a&state=b"));
        assertThrows(Exception.class, () -> OAuthProtocol.query("code=%0a"));
        assertThrows(Exception.class, () -> OAuthProtocol.query("code=%zz"));
        assertFalse(OAuthProtocol.clientId("dynamic_agent_client"));
    }
    static Map<String,String> parse(String request) throws Exception { return OAuthLoopback.parse(new ByteArrayInputStream(request.getBytes(StandardCharsets.US_ASCII)), 1455); }
    @Test public void callbackRequiresExactPathHostAndNoOriginOrRequestBody() throws Exception {
        String good = "GET /auth/callback?state=test&code=fake HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n";
        assertEquals("fake", parse(good).get("code"));
        for (String bad : new String[]{good.replace("GET", "POST"), good.replace("/auth/callback", "/callback"), good.replace("127.0.0.1", "localhost"),
                good.replace("\r\n\r\n", "\r\nOrigin: https://evil.test\r\n\r\n"), good.replace("\r\n\r\n", "\r\nContent-Length: 0\r\n\r\n"),
                good.replace("\r\n\r\n", "\r\nHost: 127.0.0.1:1455\r\n\r\n")}) assertThrows(Exception.class, () -> parse(bad));
    }
    @Test public void identityOnlyGrantCannotEnableInference() throws Exception {
        assertThrows(Exception.class, () -> ChatGptSession.build(new JSONObject().put("access_token", "fake").put("token_type", "Bearer").put("expires_in", 300).put("scope", "openid profile email"), CLIENT, "nonce", null));
    }
    static final class Store implements ChatGptSession.Storage {
        String client = "", hash = "", saved;
        public String host() { return "urn:uuid:00000000-0000-4000-8000-000000000001"; }
        public String registration() { return client; }
        public String subjectHash() { return hash; }
        public void registration(String client, String hash) { this.client = client; this.hash = hash; }
        public void save(String json) { saved = json; }
        public String restore() { return saved; }
        public void clear() { saved = null; }
        public boolean saved() { return saved != null; }
    }
    static final class Issuer implements Call.Factory {
        Map<String,String> authorize;
        AtomicInteger requests = new AtomicInteger(), exchanges = new AtomicInteger(), refreshes = new AtomicInteger(), revocations = new AtomicInteger();
        volatile boolean failRefresh, noScope, blockExchange;
        CountDownLatch exchangeStarted = new CountDownLatch(1), exchangeContinue = new CountDownLatch(1);
        String issue(Request request) throws Exception {
            String path = request.url().encodedPath();
            if (path.equals("/.well-known/openid-configuration")) return new JSONObject().put("issuer", OAuthProtocol.ISSUER)
                    .put("token_endpoint", OAuthProtocol.ISSUER + "/token").put("jwks_uri", OAuthProtocol.ISSUER + "/jwks").put("revocation_endpoint", OAuthProtocol.ISSUER + "/revoke").toString();
            if (path.equals("/jwks")) return new JSONObject().put("keys", new JSONArray().put(key())).toString();
            if (path.equals("/revoke")) { revocations.incrementAndGet(); return "{}"; }
            if (path.equals("/v1/models")) {
                assertEquals("Bearer fake-access", request.header("Authorization"));
                return "{\"models\":[{\"slug\":\"allowed-model\",\"visibility\":\"list\"},{\"slug\":\"hidden-model\",\"visibility\":\"hidden\"}]}";
            }
            if (!path.equals("/token")) throw new AssertionError("Unexpected endpoint");
            exchanges.incrementAndGet();
            assertTrue(request.body().isOneShot());
            Buffer body = new Buffer(); request.body().writeTo(body);
            Map<String,String> fields = OAuthProtocol.query(body.readUtf8());
            assertEquals(CLIENT, fields.get("client_id")); assertEquals(OAuthProtocol.RESOURCE, fields.get("resource"));
            if (fields.get("grant_type").equals("authorization_code")) {
                assertEquals(authorize.get("redirect_uri"), fields.get("redirect_uri"));
                assertEquals(authorize.get("code_challenge"), OAuthProtocol.b64(OAuthProtocol.digest(fields.get("code_verifier"))));
                if (blockExchange) { exchangeStarted.countDown(); assertTrue(exchangeContinue.await(5, TimeUnit.SECONDS)); }
            } else {
                refreshes.incrementAndGet(); assertEquals("fake-refresh", fields.get("refresh_token"));
                if (failRefresh) throw new IOException("fake secret-bearing error");
            }
            return new JSONObject().put("access_token", "fake-access").put("refresh_token", "fake-refresh").put("token_type", "Bearer")
                    .put("expires_in", 3600).put("scope", noScope ? "openid" : OAuthProtocol.SCOPES)
                    .put("id_token", jwt(claims(authorize.get("nonce")))).toString();
        }
        public Call newCall(Request request) {
            requests.incrementAndGet();
            return new Call() {
                boolean canceled;
                public Request request() { return request; }
                public Response execute() throws IOException {
                    try { return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("fake")
                            .body(ResponseBody.create(issue(request), MediaType.get("application/json"))).build(); }
                    catch (IOException failure) { throw failure; }
                    catch (Exception failure) { throw new IOException("fake transport error"); }
                }
                public void enqueue(Callback callback) { throw new UnsupportedOperationException(); }
                public void cancel() { canceled = true; }
                public boolean isExecuted() { return true; }
                public boolean isCanceled() { return canceled; }
                public Timeout timeout() { return new Timeout(); }
                public Call clone() { return newCall(request); }
            };
        }
    }
    static String callback(Issuer issuer, String extra) throws Exception {
        URI uri = new URI(issuer.authorize.get("redirect_uri"));
        try (Socket socket = new Socket("127.0.0.1", uri.getPort())) {
            socket.setSoTimeout(3000);
            String query = "state=" + issuer.authorize.get("state") + extra;
            socket.getOutputStream().write(("GET /auth/callback?" + query + " HTTP/1.1\r\nHost: 127.0.0.1:" + uri.getPort() + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            return new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    static void begin(ChatGptSession session, Issuer issuer, boolean persist) throws Exception {
        URI url = new URI(session.begin(true, persist));
        assertEquals("auth.openai.com", url.getHost());
        issuer.authorize = OAuthProtocol.query(url.getRawQuery());
        assertEquals("S256", issuer.authorize.get("code_challenge_method"));
    }
    static void waitDone(ChatGptSession session) throws Exception {
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (session.busy && System.nanoTime() < deadline) Thread.sleep(5);
        assertFalse("Login must terminate", session.busy);
    }
    @Test public void completeLocalLoginPkceModelReadAndLogoutUseOnlyFakeTransport() throws Exception {
        Store store = new Store(); Issuer issuer = new Issuer();
        try (ChatGptSession session = new ChatGptSession(store, issuer)) {
            assertEquals(0, issuer.requests.get());
            begin(session, issuer, false);
            assertEquals("dynamic_agent_client", issuer.authorize.get("client_id"));
            assertTrue(callback(issuer, "&code=fake-code&client_id=" + CLIENT).contains("200 OK"));
            waitDone(session); assertTrue(session.status, session.connected); assertNull(store.saved);
            assertEquals(CLIENT, store.client); assertEquals("fake-access", session.accessToken());
            session.loadModels(); assertTrue(session.hasModel("allowed-model")); assertFalse(session.hasModel("hidden-model"));
            session.logout(); assertFalse(session.connected); assertEquals(1, issuer.revocations.get());
        }
    }
    @Test public void wrongStateDoesNotConsumeAttemptOrExchangeCode() throws Exception {
        Store store = new Store(); Issuer issuer = new Issuer();
        try (ChatGptSession session = new ChatGptSession(store, issuer)) {
            begin(session, issuer, false); String state = issuer.authorize.put("state", "wrong");
            assertTrue(callback(issuer, "&code=fake&client_id=" + CLIENT).contains("400 Bad Request")); assertEquals(0, issuer.exchanges.get());
            issuer.authorize.put("state", state); callback(issuer, "&error=access_denied"); waitDone(session);
            assertFalse(session.connected); assertEquals(0, issuer.exchanges.get());
        }
    }
    @Test public void missingIssuedClientAndDeniedScopeCannotConnect() throws Exception {
        for (boolean missing : new boolean[]{true, false}) {
            Store store = new Store(); Issuer issuer = new Issuer(); issuer.noScope = true;
            try (ChatGptSession session = new ChatGptSession(store, issuer)) {
                begin(session, issuer, false); callback(issuer, "&code=fake" + (missing ? "" : "&client_id=" + CLIENT)); waitDone(session);
                assertFalse(session.connected); assertNull(store.saved);
            }
        }
    }
    @Test public void cancelDuringExchangeCannotActivateOrPersistSession() throws Exception {
        Store store = new Store(); Issuer issuer = new Issuer(); issuer.blockExchange = true;
        try (ChatGptSession session = new ChatGptSession(store, issuer)) {
            begin(session, issuer, true); callback(issuer, "&code=fake&client_id=" + CLIENT);
            assertTrue(issuer.exchangeStarted.await(5, TimeUnit.SECONDS)); session.cancel(); issuer.exchangeContinue.countDown();
            CountDownLatch drained = new CountDownLatch(1); session.execute(drained::countDown); assertTrue(drained.await(5, TimeUnit.SECONDS));
            assertFalse(session.connected); assertNull(store.saved);
        }
    }
    @Test public void persistenceNeedsSeparateRestoreConsentAndFreshRefresh() throws Exception {
        Store store = new Store(); Issuer issuer = new Issuer();
        try (ChatGptSession first = new ChatGptSession(store, issuer)) {
            begin(first, issuer, true); callback(issuer, "&code=fake&client_id=" + CLIENT); waitDone(first); assertNotNull(store.saved);
        }
        int before = issuer.requests.get();
        try (ChatGptSession second = new ChatGptSession(store, issuer)) {
            assertFalse(second.connected); second.restore(false); assertEquals(before, issuer.requests.get());
            second.restore(true); assertTrue(second.status, second.connected); assertEquals(1, issuer.refreshes.get());
            second.logout(); assertNull(store.saved);
        }
    }
    @Test public void uncertainRefreshClearsSessionAndNeverReplaysOldRefreshToken() throws Exception {
        Store store = new Store(); Issuer issuer = new Issuer();
        try (ChatGptSession first = new ChatGptSession(store, issuer)) {
            begin(first, issuer, true); callback(issuer, "&code=fake&client_id=" + CLIENT); waitDone(first);
        }
        issuer.failRefresh = true;
        try (ChatGptSession second = new ChatGptSession(store, issuer)) {
            second.restore(true); assertFalse(second.connected); assertNull(store.saved); assertEquals(1, issuer.refreshes.get());
            assertThrows(Exception.class, second::accessToken); assertEquals(1, issuer.refreshes.get());
        }
    }
    @Test public void responsesBodyUsesNoStorageAndCompletionIsRequired() throws Exception {
        JSONArray input = new JSONArray().put(new JSONObject().put("role", "system").put("content", "instructions"))
                .put(new JSONObject().put("role", "user").put("content", "hello"));
        JSONObject body = new JSONObject(new String(ChatClient.responsesBody("model", input), StandardCharsets.UTF_8));
        assertFalse(body.getBoolean("store")); assertTrue(body.getBoolean("stream")); assertFalse(body.has("messages")); assertEquals(1, body.getJSONArray("input").length());
        String delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n";
        String done = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n";
        StringBuilder text = new StringBuilder();
        ChatClient.parseSse(new ByteArrayInputStream((delta + done).getBytes(StandardCharsets.UTF_8)), new java.util.concurrent.atomic.AtomicBoolean(), text::append, true);
        assertEquals("hello", text.toString());
        assertThrows(IOException.class, () -> ChatClient.parseSse(new ByteArrayInputStream(delta.getBytes(StandardCharsets.UTF_8)), new java.util.concurrent.atomic.AtomicBoolean(), ignored -> {}, true));
        String tool = "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\"}}\n\n";
        assertThrows(IOException.class, () -> ChatClient.parseSse(new ByteArrayInputStream(tool.getBytes(StandardCharsets.UTF_8)), new java.util.concurrent.atomic.AtomicBoolean(), ignored -> {}, true));
    }
}
