package io.github.colorsn99.whisper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Ephemeral IPv4 loopback only; no Android exported callback or public execution endpoint. */
final class OAuthLoopback implements AutoCloseable {
    interface Callback { boolean accept(Map<String, String> values); }
    private final ServerSocket server;
    private volatile boolean closed;
    private volatile Socket active;
    OAuthLoopback() throws Exception {
        server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        server.setSoTimeout(1000);
    }
    String redirect() { return "http://127.0.0.1:" + server.getLocalPort() + "/auth/callback"; }
    void listen(Callback callback, Runnable expired) {
        Thread thread = new Thread(() -> {
            long deadline = System.nanoTime() + 600_000_000_000L;
            try {
                while (!closed && System.nanoTime() < deadline) {
                    try (Socket socket = server.accept()) {
                        active = socket;
                        socket.setSoTimeout(2000);
                        boolean accepted = false;
                        try { accepted = callback.accept(parse(socket.getInputStream(), server.getLocalPort())); }
                        catch (Exception ignored) { /* Never echo request data. */ }
                        String body = accepted
                                ? "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>whisper</title><h2>授权已收到</h2><p>请切回 whisper 查看登录结果。你可以关闭这个页面。</p>"
                                : "<!doctype html><meta charset=utf-8><title>whisper</title><p>回调无效或已过期，请返回 whisper 重新登录。</p>";
                        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                        String headers = "HTTP/1.1 " + (accepted ? "200 OK" : "400 Bad Request") + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + bytes.length
                                + "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
                        socket.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().write(bytes);
                        if (accepted) return;
                    } catch (java.io.IOException ignored) { }
                }
                if (!closed) expired.run();
            } finally { close(); }
        }, "whisper-oauth-loopback");
        thread.setDaemon(true); thread.start();
    }
    static Map<String, String> parse(InputStream input, int port) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int matched = 0;
        long deadline = System.nanoTime() + 3_000_000_000L;
        while (matched < 4) {
            if (System.nanoTime() > deadline) throw OAuthProtocol.failure();
            int value = input.read();
            if (value < 0 || bytes.size() >= 20000 || value > 127 || value == 0) throw OAuthProtocol.failure();
            bytes.write(value);
            int expected = matched % 2 == 0 ? '\r' : '\n';
            matched = value == expected ? matched + 1 : (value == '\r' ? 1 : 0);
        }
        String[] lines = bytes.toString("US-ASCII").split("\r\n");
        String[] request = lines[0].split(" ");
        if (request.length != 3 || !request[0].equals("GET") || !request[2].equals("HTTP/1.1")
                || !request[1].startsWith("/auth/callback?") || request[1].contains("#")) throw OAuthProtocol.failure();
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0) throw OAuthProtocol.failure();
            String key = lines[i].substring(0, colon).toLowerCase(Locale.ROOT);
            if (!key.matches("[a-z0-9-]+") || headers.put(key, lines[i].substring(colon + 1).trim()) != null) throw OAuthProtocol.failure();
        }
        if (!("127.0.0.1:" + port).equals(headers.get("host")) || headers.containsKey("origin")
                || headers.containsKey("transfer-encoding") || headers.containsKey("content-length")) throw OAuthProtocol.failure();
        return OAuthProtocol.query(request[1].substring("/auth/callback?".length()));
    }
    @Override public void close() { closed = true; try { Socket socket = active; if (socket != null) socket.close(); server.close(); } catch (java.io.IOException ignored) { } }
}
