package io.github.colorsn99.whisper;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/** Pure protocol validation. All endpoints and issuer are fixed, never supplied by a token. */
final class OAuthProtocol {
    static final String ISSUER = "https://auth.openai.com";
    static final String RESOURCE = "https://api.openai.com/v1";
    static final String SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    static IOException failure() { return new IOException("ChatGPT 授权校验未通过，请重新登录。"); }
    static String random() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return b64(bytes); }
    static String b64(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    static byte[] digest(String text) throws Exception { return MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)); }
    static boolean equal(String a, String b) {
        return a != null && b != null && MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
    static String text(JSONObject json, String key, int max) throws Exception {
        Object raw = json.opt(key);
        if (!(raw instanceof String) || ((String) raw).isEmpty() || ((String) raw).length() > max
                || ((String) raw).matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw failure();
        return (String) raw;
    }
    static boolean clientId(String id) { return id != null && id.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,255}") && !id.equals("dynamic_agent_client"); }
    static String form(Map<String, String> fields) throws Exception {
        StringBuilder result = new StringBuilder();
        for (Map.Entry<String, String> entry : fields.entrySet()) {
            if (result.length() > 0) result.append('&');
            result.append(URLEncoder.encode(entry.getKey(), "UTF-8")).append('=').append(URLEncoder.encode(entry.getValue(), "UTF-8"));
        }
        return result.toString();
    }
    static Map<String, String> fields(String... values) {
        Map<String, String> result = new LinkedHashMap<>();
        for (int i = 0; i < values.length; i += 2) result.put(values[i], values[i + 1]);
        return result;
    }
    static Map<String, String> query(String raw) throws Exception {
        if (raw == null || raw.length() > 16384) throw failure();
        Map<String, String> result = new LinkedHashMap<>();
        for (String field : raw.split("&")) {
            String[] pair = field.split("=", 2);
            if (pair.length != 2) throw failure();
            String key = URLDecoder.decode(pair[0], "UTF-8"), value = URLDecoder.decode(pair[1], "UTF-8");
            if (result.put(key, value) != null || value.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw failure();
        }
        return result;
    }
    static String endpoint(String url) throws Exception {
        URI uri = new URI(url);
        if (!ISSUER.equals(uri.getScheme() + "://" + uri.getRawAuthority()) || uri.getRawQuery() != null
                || uri.getRawFragment() != null || uri.getRawUserInfo() != null) throw failure();
        return url;
    }
    static JSONObject json(String text) throws Exception { LocalStore.validateJsonSyntax(text); return new JSONObject(text); }
    static long integer(JSONObject object, String name) throws Exception {
        Object value = object.opt(name);
        if (!(value instanceof Number) || ((Number) value).doubleValue() != ((Number) value).longValue()) throw failure();
        return ((Number) value).longValue();
    }
    static JSONObject verify(String jwt, JSONArray keys, String client, String nonce, String access,
                             boolean refresh, long now) throws Exception {
        if (jwt == null || jwt.length() > 24000) throw failure();
        String[] parts = jwt.split("\\.", -1);
        if (parts.length != 3) throw failure();
        for (String part : parts) if (!part.matches("[A-Za-z0-9_-]+")) throw failure();
        JSONObject header = json(new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8));
        JSONObject claims = json(new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8));
        if (!"RS256".equals(header.optString("alg")) || header.has("crit") || header.has("jku") || header.has("jwk") || header.has("x5u")) throw failure();
        String kid = text(header, "kid", 512);
        JSONObject match = null;
        if (keys == null || keys.length() > 100) throw failure();
        for (int i = 0; i < keys.length(); i++) {
            JSONObject key = keys.getJSONObject(i);
            if (!kid.equals(key.optString("kid")) || !"RSA".equals(key.optString("kty"))) continue;
            if (!"sig".equals(key.optString("use", "sig")) || !"RS256".equals(key.optString("alg", "RS256"))) continue;
            if (key.has("key_ops") && !key.getJSONArray("key_ops").toString().contains("\"verify\"")) continue;
            if (match != null) throw failure();
            match = key;
        }
        if (match == null) throw failure();
        BigInteger modulus = new BigInteger(1, Base64.getUrlDecoder().decode(text(match, "n", 2000)));
        BigInteger exponent = new BigInteger(1, Base64.getUrlDecoder().decode(text(match, "e", 16)));
        if (modulus.bitLength() < 2048 || modulus.bitLength() > 8192) throw failure();
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initVerify(KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(modulus, exponent)));
        signature.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
        if (!signature.verify(Base64.getUrlDecoder().decode(parts[2]))) throw failure();
        if (!ISSUER.equals(claims.optString("iss"))) throw failure();
        Object aud = claims.opt("aud");
        boolean matches = client.equals(aud);
        if (aud instanceof JSONArray) {
            JSONArray audiences = (JSONArray) aud;
            for (int i = 0; i < audiences.length(); i++) if (client.equals(audiences.optString(i))) matches = true;
            if (audiences.length() > 1 && !client.equals(claims.optString("azp"))) throw failure();
        }
        if (!matches || (claims.has("azp") && !client.equals(claims.optString("azp")))) throw failure();
        if (integer(claims, "exp") <= now - 5 || integer(claims, "iat") > now + 5
                || (claims.has("nbf") && integer(claims, "nbf") > now + 5)) throw failure();
        text(claims, "sub", 512);
        if (!(refresh && !claims.has("nonce")) && !equal(nonce, claims.optString("nonce"))) throw failure();
        if (claims.has("at_hash") && !equal(b64(Arrays.copyOf(digest(access), 16)), claims.optString("at_hash"))) throw failure();
        return claims;
    }
}
