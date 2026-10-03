package io.github.colorsn99.whisper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.CookieJar;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.Timeout;

import static org.junit.Assert.*;

/** Pure/fake-transport tests plus one loopback-only HTTP retry regression. No API calls. */
public class ChatClientTest {
    private static final String ENDPOINT = "https://api.vendor.com/v1";
    private static final String SECRET = "fake-vendor-token-for-offline-tests";

    @Test public void endpointNormalizesOnlySupportedThirdPartyUrls() {
        assertEquals(ENDPOINT + "/chat/completions", ChatClient.validateEndpoint(ENDPOINT));
        assertEquals(ENDPOINT + "/chat/completions", ChatClient.validateEndpoint("https://API.VENDOR.COM:443/v1/"));
        assertEquals(ENDPOINT + "/chat/completions", ChatClient.validateEndpoint("https://api.vendor.com"));
        assertEquals(ENDPOINT + "/chat/completions", ChatClient.validateEndpoint(ENDPOINT + "/chat/completions"));
    }

    @Test public void endpointRejectsPrivateNamesUrlCredentialsAndOpenaiFallback() {
        for (String endpoint : Arrays.asList(
                "http://api.vendor.com/v1", "https://api.vendor.com:8443/v1", "https://localhost/v1",
                "https://router.local/v1", "https://router.internal/v1", "https://router.test/v1",
                "https://127.0.0.1/v1", "https://[::1]/v1", "https://2130706433/v1",
                "https://user:password@api.vendor.com/v1", "https://api.vendor.com/v1?api_key=secret",
                "https://api.vendor.com/v1#secret", "https://api.vendor.com./v1",
                "https://api.openai.com/v1", "https://openai.com/v1", "https://chatgpt.com/v1",
                "https://tenant.openai.azure.com/v1", "https://openai.azure.com/v1",
                "https://api.vendor.com/v1/../private", "https://api.vendor.com/%2e%2e/v1",
                "https://api.vendor.com//v1", " https://api.vendor.com/v1")) {
            assertThrows(endpoint, IllegalArgumentException.class, () -> ChatClient.validateEndpoint(endpoint));
        }
    }

    @Test public void publicAddressPolicyRejectsLocalAndSpecialRanges() throws Exception {
        for (int[] ip : new int[][]{{0,0,0,0},{10,1,2,3},{127,0,0,1},{169,254,1,2},{172,16,1,2},
                {172,31,255,255},{192,168,1,2},{100,64,1,2},{100,127,255,254},{192,0,2,1},
                {198,18,0,1},{198,19,0,1},{198,51,100,1},{203,0,113,1},{224,0,0,1},{255,255,255,255}}) {
            assertFalse(Arrays.toString(ip), ChatClient.isPublicAddress(ipv4(ip)));
        }
        assertTrue(ChatClient.isPublicAddress(ipv4(8,8,8,8)));
        assertTrue(ChatClient.isPublicAddress(ipv4(1,1,1,1)));
        assertFalse(ChatClient.isPublicAddress(InetAddress.getByAddress(new byte[16])));
        byte[] v6 = new byte[16]; v6[0] = (byte) 0xfc;
        assertFalse(ChatClient.isPublicAddress(InetAddress.getByAddress(v6)));
        v6[0] = 0x20; v6[1] = 0x01; v6[2] = 0x0d; v6[3] = (byte) 0xb8;
        assertFalse(ChatClient.isPublicAddress(InetAddress.getByAddress(v6)));
        v6[1] = 0x02;
        assertFalse(ChatClient.isPublicAddress(InetAddress.getByAddress(v6)));
        v6[0] = 0x26; v6[1] = 0x06; v6[2] = 0x47; v6[3] = 0;
        assertTrue(ChatClient.isPublicAddress(InetAddress.getByAddress(v6)));
    }

    @Test public void dnsReturnsTheExactValidatedAddressesWithoutASecondResolution() throws Exception {
        AtomicInteger resolutions = new AtomicInteger();
        InetAddress publicIp = ipv4(8,8,8,8);
        List<InetAddress> addresses = ChatClient.publicDns(host -> {
            resolutions.incrementAndGet();
            return new InetAddress[]{publicIp};
        }).lookup("api.vendor.com");
        assertEquals(1, resolutions.get());
        assertSame(publicIp, addresses.get(0));
        assertThrows(UnsupportedOperationException.class, () -> addresses.add(publicIp));
        assertThrows(UnknownHostException.class, () -> ChatClient.publicDns(host ->
                new InetAddress[]{publicIp, ipv4(127,0,0,1)}).lookup("api.vendor.com"));
        UnknownHostException failure = assertThrows(UnknownHostException.class, () ->
                ChatClient.publicDns(host -> { throw new UnknownHostException(SECRET); }).lookup("api.vendor.com"));
        assertFalse(failure.getMessage().contains(SECRET));
    }

    @Test public void transportExplicitlyDisablesProxyRedirectRetryCookiesAndDiskCache() {
        OkHttpClient client = ChatClient.secureHttpClient(host -> new InetAddress[0]);
        assertEquals(Proxy.NO_PROXY, client.proxy());
        assertFalse(client.followRedirects());
        assertFalse(client.followSslRedirects());
        assertFalse(client.retryOnConnectionFailure());
        assertSame(CookieJar.NO_COOKIES, client.cookieJar());
        assertNull(client.cache());
        assertEquals(15_000, client.connectTimeoutMillis());
        assertEquals(30_000, client.readTimeoutMillis());
        assertEquals(300_000, client.callTimeoutMillis());
        assertNotNull(client.hostnameVerifier());
        assertNotNull(client.sslSocketFactory());
    }

    @Test public void requestCopiesOnlyTextChatFields() throws Exception {
        JSONArray source = messages("hello");
        source.getJSONObject(0).put("tool_calls", new JSONArray()).put("authorization", SECRET);
        JSONObject body = new JSONObject(new String(ChatClient.requestBody("vendor/model-v1", source), StandardCharsets.UTF_8));
        assertEquals(3, body.length());
        assertTrue(body.getBoolean("stream"));
        assertEquals("vendor/model-v1", body.getString("model"));
        assertEquals(2, body.getJSONArray("messages").getJSONObject(0).length());
        assertFalse(body.toString().contains(SECRET));
        assertThrows(IOException.class, () -> ChatClient.requestBody("bad\nmodel", source));
        assertThrows(IOException.class, () -> ChatClient.requestBody("model", messages("\ud800")));
        assertThrows(IOException.class, () -> ChatClient.requestBody("model", new JSONArray()));
        assertThrows(IOException.class, () -> ChatClient.requestBody("model", new JSONArray().put(new JSONObject().put("role", "tool").put("content", "x"))));
    }

    @Test public void sseDecodesSplitUtf8CommentsCrLfAndDone() throws Exception {
        String stream = "\ufeff: keepalive\r\nid: 1\r\n" + event("你🙂", null).replace("\n", "\r\n") + "data: [DONE]\r\n\r\n";
        StringBuilder text = new StringBuilder();
        InputStream bytes = new ByteArrayInputStream(stream.getBytes(StandardCharsets.UTF_8)) {
            @Override public synchronized int read(byte[] buffer, int offset, int length) { return super.read(buffer, offset, Math.min(length, 1)); }
        };
        ChatClient.parseSse(bytes, new AtomicBoolean(), text::append);
        assertEquals("你🙂", text.toString());
    }

    @Test public void sseAcceptsExplicitStopAndMultilineData() throws Exception {
        assertEquals("hello", parse(event("hello", "stop")));
        assertEquals("a", parse("data: {\ndata: \"choices\":[{\"index\":0,\"delta\":{\"content\":\"a\"},\"finish_reason\":\"stop\"}]}\n\n"));
        assertEquals("a", parse("data: {\"choices\":[]}\n\n" + event("a", null) + "data: [DONE]\n\n"));
    }

    @Test public void sseDoesNotTreatEofOrUndispatchedDataAsCompletion() throws Exception {
        StringBuilder text = new StringBuilder();
        assertThrows(IOException.class, () -> ChatClient.parseSse(bytes(event("partial", null)), new AtomicBoolean(), text::append));
        assertEquals("partial", text.toString());
        assertThrows(IOException.class, () -> parse(event("complete", "stop").trim()));
        assertThrows(IOException.class, () -> parse("data: [DONE]\n\n"));
        assertThrows(IOException.class, () -> parse(event("", "stop")));
        assertThrows(IOException.class, () -> parse("data: {\"choices\":[{}]}\n\ndata: [DONE]\n\n"));
    }

    @Test public void ssePreservesPartialTextButFailsLengthOrFilterCompletion() throws Exception {
        for (String reason : Arrays.asList("length", "content_filter", "tool_calls", "unknown")) {
            StringBuilder text = new StringBuilder();
            assertThrows(IOException.class, () -> ChatClient.parseSse(bytes(event("partial", reason)), new AtomicBoolean(), text::append));
            assertEquals("partial", text.toString());
        }
    }

    @Test public void sseRejectsToolCallsBranchesMalformedJsonAndRawErrors() throws Exception {
        for (String bad : Arrays.asList(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"function_call\":{}}}]}\n\n",
                "data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"x\"}}]}\n\n",
                "data: {\"choices\":[{},{}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":42}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"\\ud800\"}}]}\n\n",
                "data: not-json-" + SECRET + "\n\n",
                "data: {\"error\":\"" + SECRET + "\"}\n\n")) {
            IOException failure = assertThrows(IOException.class, () -> parse(bad));
            assertFalse(failure.getMessage().contains(SECRET));
        }
    }

    @Test public void sseBoundsTextLinesBytesAndJsonNesting() throws Exception {
        assertThrows(IOException.class, () -> parse(event("a".repeat(128 * 1024 + 1), "stop")));
        assertThrows(IOException.class, () -> parse(":" + "a".repeat(512 * 1024 + 1) + "\n\n"));
        assertThrows(IOException.class, () -> parse((":" + "a".repeat(32 * 1024) + "\n").repeat(130)));
        assertThrows(IOException.class, () -> parse("data: {\"choices\":[] ,\"x\":" + "[".repeat(80) + "0" + "]".repeat(80) + "}\n\n"));
        ChatClient.validateJsonDepth(new JSONObject().put("text", "[\"[{".repeat(100)).toString());
        assertThrows(IOException.class, () -> ChatClient.validateJsonDepth("{'text':']]]]]'}"));
        assertThrows(IOException.class, () -> ChatClient.validateJsonDepth("{unquoted:1}"));
    }

    @Test public void sseRejectsInvalidUtf8AndCancellation() throws Exception {
        assertThrows(IOException.class, () -> ChatClient.parseSse(new ByteArrayInputStream(new byte[]{(byte) 0xc3, 0x28}), new AtomicBoolean(), text -> {}));
        assertThrows(IOException.class, () -> ChatClient.parseSse(bytes(event("x", "stop")), new AtomicBoolean(true), text -> fail("No delta after cancel")));
    }

    @Test public void redactorRecognizesTokensAcrossDeltaBoundaries() throws Exception {
        StringBuilder output = new StringBuilder();
        ChatClient.SecretRedactor redactor = new ChatClient.SecretRedactor(SECRET, output::append);
        redactor.accept("before " + SECRET.substring(0, 7));
        redactor.accept(SECRET.substring(7) + " after");
        redactor.finish();
        assertEquals("before [已隐藏凭据] after", output.toString());
        assertFalse(output.toString().contains(SECRET));
        ChatClient.SecretRedactor partial = new ChatClient.SecretRedactor(SECRET, output::append);
        partial.accept(" " + SECRET.substring(0, 10));
        partial.finish();
        assertTrue(output.toString().endsWith(" [已隐藏凭据片段]"));
    }

    @Test public void tinyFastDeltasAreBatchedWithoutLosingFirstOrFinalText() throws Exception {
        StringBuilder output = new StringBuilder();
        AtomicInteger callbacks = new AtomicInteger();
        AtomicLong clock = new AtomicLong();
        ChatClient.DeltaBatcher batcher = new ChatClient.DeltaBatcher(text -> { callbacks.incrementAndGet(); output.append(text); }, clock::get);
        batcher.accept("first");
        assertEquals("first", output.toString());
        for (int i = 0; i < 10_000; i++) batcher.accept("a");
        assertTrue("a flood of events must not become a flood of UI callbacks", callbacks.get() < 10);
        batcher.finish();
        assertEquals("first" + "a".repeat(10_000), output.toString());
        batcher.accept("b");
        int before = callbacks.get();
        clock.set(34_000_000L);
        batcher.accept("c");
        assertEquals(before + 1, callbacks.get());
        assertTrue(output.toString().endsWith("bc"));
    }

    @Test public void fakeTransportCompletesOnceAndRedactsEchoedCredential() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        RecordingListener listener = new RecordingListener();
        try (ChatClient client = new ChatClient(request -> {
            calls.incrementAndGet();
            assertEquals("Bearer " + SECRET, request.header("Authorization"));
            assertTrue("billed POST bodies must never be replayed", request.body().isOneShot());
            return new FakeCall(request, 200, event("reply " + SECRET, "stop"), false);
        }, Executors.newSingleThreadExecutor())) {
            client.stream(ENDPOINT, SECRET, "vendor-model", messages("question"), listener);
            listener.await();
            assertEquals("reply [已隐藏凭据]", listener.text.toString());
            assertEquals(1, listener.completed.get());
            assertNull(listener.error.get());
            assertEquals(1, calls.get());
        }
    }

    @Test public void fakeTransportRejectsRedirectsAndHttpErrorsWithoutReadingRawBody() throws Exception {
        for (int code : new int[]{302, 401, 429, 500}) {
            AtomicInteger calls = new AtomicInteger();
            RecordingListener listener = new RecordingListener();
            try (ChatClient client = new ChatClient(request -> {
                calls.incrementAndGet(); return new FakeCall(request, code, SECRET, false);
            }, Executors.newSingleThreadExecutor())) {
                client.stream(ENDPOINT, SECRET, "model", messages("x"), listener);
                listener.await();
                assertEquals(1, calls.get());
                assertEquals(0, listener.completed.get());
                assertNotNull(listener.error.get());
                assertFalse(listener.error.get().contains(SECRET));
                assertEquals("", listener.text.toString());
            }
        }
    }

    @Test public void realOkHttpDoesNotReplayPostFor503RetryAfterZero() throws Exception {
        // A fixed loopback fixture exercises OkHttp's real follow-up interceptor.
        // Production stream() never accepts this HTTP/IP/ephemeral-port URL.
        ExecutorService fixtureExecutor = Executors.newSingleThreadExecutor();
        try (ServerSocket server = new ServerSocket(0, 2, ipv4(127,0,0,1))) {
            server.setSoTimeout(5000);
            AtomicInteger requests = new AtomicInteger();
            Future<?> fixture = fixtureExecutor.submit(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(3000);
                        BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                        int length = 0;
                        for (int lines = 0; lines < 64; lines++) {
                            String line = reader.readLine();
                            if (line == null) throw new IOException("truncated fixture request");
                            if (line.isEmpty()) break;
                            if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                        }
                        for (int i = 0; i < length; i++) if (reader.read() < 0) throw new IOException("truncated fixture body");
                        requests.incrementAndGet();
                        socket.getOutputStream().write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().flush();
                    } catch (SocketException failure) {
                        if (!server.isClosed()) throw new AssertionError(failure);
                    } catch (IOException failure) { throw new AssertionError(failure); }
                }
            });
            OkHttpClient http = ChatClient.secureHttpClient(host -> { throw new UnknownHostException("fixture must not resolve DNS"); });
            try {
                okhttp3.Request request = new okhttp3.Request.Builder().url("http://127.0.0.1:" + server.getLocalPort() + "/fixture")
                        .post(ChatClient.oneShotBody("{}".getBytes(StandardCharsets.UTF_8))).build();
                try (Response response = http.newCall(request).execute()) { assertEquals(503, response.code()); }
                server.close(); // Synchronous execute has finished all possible follow-ups.
                fixture.get(3, TimeUnit.SECONDS);
                assertEquals("503 Retry-After: 0 must not replay a POST", 1, requests.get());
            } finally {
                http.connectionPool().evictAll();
                http.dispatcher().executorService().shutdown();
            }
        } finally { fixtureExecutor.shutdownNow(); }
    }

    @Test public void invalidConfigurationNeverCreatesATransportCall() throws Exception {
        for (String[] configuration : new String[][]{{"https://api.openai.com/v1", SECRET}, {ENDPOINT, "sk-proj-fake"}, {ENDPOINT, "token\r\nInjected:yes"}}) {
            RecordingListener listener = new RecordingListener();
            try (ChatClient client = new ChatClient(request -> { fail("No transport for invalid configuration"); return null; }, Executors.newSingleThreadExecutor())) {
                client.stream(configuration[0], configuration[1], "model", messages("x"), listener);
                listener.await();
                assertNotNull(listener.error.get());
                assertEquals(0, listener.completed.get());
            }
        }
    }

    @Test public void cancelStopsTheSingleActiveCallAndProducesOneTerminalError() throws Exception {
        AtomicReference<FakeCall> call = new AtomicReference<>();
        CountDownLatch created = new CountDownLatch(1);
        RecordingListener listener = new RecordingListener();
        try (ChatClient client = new ChatClient(request -> {
            FakeCall fake = new FakeCall(request, 200, "", true); call.set(fake); created.countDown(); return fake;
        }, Executors.newSingleThreadExecutor())) {
            ChatClient.Request request = client.stream(ENDPOINT, SECRET, "model", messages("x"), listener);
            assertTrue(created.await(3, TimeUnit.SECONDS));
            assertThrows(IllegalStateException.class, () -> client.stream(ENDPOINT, SECRET, "model", messages("x"), new RecordingListener()));
            request.cancel(); request.cancel();
            listener.await();
            assertTrue(request.isCancelled());
            assertTrue(call.get().isCanceled());
            assertEquals(0, listener.completed.get());
            assertEquals(1, listener.errors.get());
        }
    }

    @Test public void queuedRequestUsesAnImmutableMessageSnapshot() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1);
        executor.execute(() -> { try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } });
        AtomicReference<String> sent = new AtomicReference<>();
        RecordingListener listener = new RecordingListener();
        try (ChatClient client = new ChatClient(request -> {
            try { Buffer buffer = new Buffer(); request.body().writeTo(buffer); sent.set(buffer.readUtf8()); }
            catch (IOException failure) { throw new AssertionError(failure); }
            return new FakeCall(request, 200, event("ok", "stop"), false);
        }, executor)) {
            JSONArray original = messages("before");
            client.stream(ENDPOINT, SECRET, "model", original, listener);
            original.getJSONObject(0).put("content", "after");
            release.countDown(); listener.await();
            assertEquals("before", new JSONObject(sent.get()).getJSONArray("messages").getJSONObject(0).getString("content"));
        }
    }

    @Test public void closeBeforeQueuedRequestStartsStillTerminatesWithoutTransport() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1);
        executor.execute(() -> { try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } });
        RecordingListener listener = new RecordingListener();
        ChatClient client = new ChatClient(request -> { fail("Closed request must not create a call"); return null; }, executor);
        client.stream(ENDPOINT, SECRET, "model", messages("x"), listener);
        client.close();
        release.countDown();
        listener.await();
        assertEquals(1, listener.errors.get());
        assertEquals(0, listener.completed.get());
        assertThrows(IllegalStateException.class, () -> client.stream(ENDPOINT, SECRET, "model", messages("x"), listener));
    }

    private static InetAddress ipv4(int... values) throws UnknownHostException {
        byte[] bytes = new byte[4]; for (int i = 0; i < 4; i++) bytes[i] = (byte) values[i];
        return InetAddress.getByAddress(bytes);
    }
    private static JSONArray messages(String content) throws Exception { return new JSONArray().put(new JSONObject().put("role", "user").put("content", content)); }
    private static String event(String content, String finish) {
        try {
            JSONObject choice = new JSONObject().put("index", 0).put("delta", new JSONObject().put("content", content));
            if (finish != null) choice.put("finish_reason", finish);
            return "data: " + new JSONObject().put("choices", new JSONArray().put(choice)) + "\n\n";
        } catch (JSONException failure) { throw new AssertionError(failure); }
    }
    private static InputStream bytes(String stream) { return new ByteArrayInputStream(stream.getBytes(StandardCharsets.UTF_8)); }
    private static String parse(String stream) throws IOException {
        StringBuilder text = new StringBuilder(); ChatClient.parseSse(bytes(stream), new AtomicBoolean(), text::append); return text.toString();
    }

    private static final class RecordingListener implements ChatClient.Listener {
        final StringBuilder text = new StringBuilder();
        final AtomicInteger completed = new AtomicInteger(), errors = new AtomicInteger();
        final AtomicReference<String> error = new AtomicReference<>();
        final CountDownLatch done = new CountDownLatch(1);
        public void onDelta(String delta) { text.append(delta); }
        public void onComplete() { completed.incrementAndGet(); done.countDown(); }
        public void onError(String message) { errors.incrementAndGet(); error.set(message); done.countDown(); }
        void await() throws InterruptedException { assertTrue("request must reach a terminal callback", done.await(5, TimeUnit.SECONDS)); }
    }

    private static final class FakeCall implements Call {
        final okhttp3.Request request;
        final int status;
        final String body;
        final boolean waitForCancel;
        final CountDownLatch stopped = new CountDownLatch(1);
        volatile boolean executed, canceled;
        FakeCall(okhttp3.Request request, int status, String body, boolean waitForCancel) { this.request = request; this.status = status; this.body = body; this.waitForCancel = waitForCancel; }
        @Override public okhttp3.Request request() { return request; }
        @Override public Response execute() throws IOException {
            executed = true;
            if (waitForCancel) {
                try { if (!stopped.await(5, TimeUnit.SECONDS)) throw new IOException("fake transport timeout"); }
                catch (InterruptedException failure) { Thread.currentThread().interrupt(); }
                throw new IOException(SECRET); // caller must never display raw transport errors
            }
            return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("fake")
                    .header("Content-Type", "text/event-stream; charset=utf-8")
                    .body(ResponseBody.create(body, MediaType.get("text/event-stream"))).build();
        }
        @Override public void enqueue(Callback callback) { throw new UnsupportedOperationException("test uses synchronous execution"); }
        @Override public void cancel() { canceled = true; stopped.countDown(); }
        @Override public boolean isExecuted() { return executed; }
        @Override public boolean isCanceled() { return canceled; }
        @Override public Timeout timeout() { return new Timeout(); }
        @Override public Call clone() { return new FakeCall(request, status, body, waitForCancel); }
    }
}
