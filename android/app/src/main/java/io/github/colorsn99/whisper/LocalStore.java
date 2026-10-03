package io.github.colorsn99.whisper;

import android.content.Context;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.Locale;

/** Private, bounded chat metadata. Credentials belong only in CredentialStore. */
public final class LocalStore {
    static final int MAX_BYTES = 2 * 1024 * 1024;
    static final int MAX_DEPTH = 64;
    private static final int MAX_VALUES = 100_000;
    private static final Object DISK_LOCK = new Object();
    private final File file;
    private final AtomicFile atomicFile;

    public LocalStore(Context context) {
        file = new File(context.getFilesDir(), "whisper-state.json");
        atomicFile = new AtomicFile(file);
    }

    public synchronized JSONObject load() throws IOException {
        synchronized (DISK_LOCK) {
            if (!file.exists() && !new File(file.getPath() + ".bak").exists()) {
                return new JSONObject();
            }
            try (FileInputStream input = atomicFile.openRead()) {
                return decodeState(readBounded(input, MAX_BYTES));
            }
        }
    }

    public synchronized void save(JSONObject state) throws IOException {
        // Copy and validate before touching the previous committed state.
        byte[] bytes = encodeState(state);
        synchronized (DISK_LOCK) {
            FileOutputStream output = null;
            try {
                output = atomicFile.startWrite();
                output.write(bytes);
                output.getFD().sync();
                atomicFile.finishWrite(output);
                output = null;
            } catch (IOException | RuntimeException failure) {
                if (output != null) atomicFile.failWrite(output);
                throw new IOException("Unable to save local chat state.", failure);
            }
            // Some AtomicFile implementations log a failed rename instead of
            // throwing. Verify the recoverable record before reporting success.
            // This is outside the write catch: never failWrite a finished stream.
            try (FileInputStream input = atomicFile.openRead()) {
                verifyStoredBytes(bytes, readBounded(input, MAX_BYTES));
            } catch (IOException | RuntimeException failure) {
                throw new IOException("Unable to verify saved local chat state.");
            }
        }
    }

    static void verifyStoredBytes(byte[] expected, byte[] actual) throws IOException {
        if (expected == null || actual == null || !Arrays.equals(expected, actual)) {
            throw new IOException("Stored data could not be verified.");
        }
    }

    static byte[] encodeState(JSONObject state) throws IOException {
        JSONObject snapshot = snapshot(state);
        String serialized = snapshot.toString();
        if (serialized == null) throw invalidState();
        return encodeUtf8(serialized, MAX_BYTES);
    }

    static JSONObject decodeState(byte[] bytes) throws IOException {
        if (bytes == null || bytes.length > MAX_BYTES) throw invalidState();
        String text = decodeUtf8(bytes);
        validateJsonSyntax(text);
        try {
            JSONTokener parser = new JSONTokener(text);
            Object value = parser.nextValue();
            if (!(value instanceof JSONObject) || parser.nextClean() != 0) {
                throw invalidState();
            }
            return snapshot((JSONObject) value);
        } catch (JSONException | RuntimeException failure) {
            // Never include parser messages: they can contain the source document.
            throw invalidState();
        }
    }

    static void validateJsonSyntax(String text) throws IOException {
        if (text == null) throw invalidState();
        new JsonPolicyScanner(text).validate();
    }

    static boolean isForbiddenField(String field) {
        if (field == null) return true;
        String normalized = Normalizer.normalize(field, Normalizer.Form.NFKC)
                .toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
        if (normalized.equals("credentialid")) return false;
        return normalized.contains("apikey")
                || normalized.contains("accesstoken")
                || normalized.contains("refreshtoken")
                || normalized.contains("idtoken")
                || normalized.contains("apitoken")
                || normalized.contains("authtoken")
                || normalized.contains("bearertoken")
                || normalized.contains("sessiontoken")
                || normalized.contains("authorization")
                || normalized.contains("secret")
                || normalized.contains("password")
                || normalized.contains("privatekey")
                || normalized.contains("clientassertion")
                || normalized.contains("codeverifier")
                || normalized.equals("token") || normalized.equals("tokens")
                || normalized.equals("credential") || normalized.equals("credentials")
                || normalized.equals("cookie") || normalized.equals("cookies")
                || normalized.equals("authcode") || normalized.equals("oauthcode")
                || normalized.equals("bearer") || normalized.equals("authentication")
                || field.contains("密钥") || field.contains("密码") || field.contains("令牌");
    }

    static byte[] readBounded(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(Math.min(maximum, 8192));
        byte[] chunk = new byte[8192];
        int count;
        while ((count = input.read(chunk)) != -1) {
            if (count > maximum - bytes.size()) throw new IOException("Stored data exceeds its size limit.");
            bytes.write(chunk, 0, count);
        }
        return bytes.toByteArray();
    }

    static String decodeUtf8(byte[] bytes) throws IOException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException failure) {
            throw new IOException("Stored data is not valid UTF-8.");
        }
    }

    private static byte[] encodeUtf8(String value, int maximum) throws IOException {
        if (value.length() > maximum) throw invalidState();
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .encode(CharBuffer.wrap(value));
            if (encoded.remaining() > maximum) throw invalidState();
            byte[] bytes = new byte[encoded.remaining()];
            encoded.get(bytes);
            return bytes;
        } catch (CharacterCodingException failure) {
            throw invalidState();
        }
    }

    private static JSONObject snapshot(JSONObject state) throws IOException {
        if (state == null) throw invalidState();
        try {
            return (JSONObject) copyValue(state, 0, new IdentityHashMap<>(), new Budget());
        } catch (JSONException | RuntimeException failure) {
            throw invalidState();
        }
    }

    private static Object copyValue(Object value, int depth,
            IdentityHashMap<Object, Boolean> visiting, Budget budget) throws IOException, JSONException {
        if (depth > MAX_DEPTH || ++budget.values > MAX_VALUES) throw invalidState();
        if (value == null || value == JSONObject.NULL) return JSONObject.NULL;
        if (value instanceof String) {
            budget.add((String) value);
            return value;
        }
        if (value instanceof Boolean) return value;
        if (value instanceof Byte || value instanceof Short || value instanceof Integer
                || value instanceof Long || value instanceof Float || value instanceof Double
                || value instanceof BigInteger || value instanceof BigDecimal) {
            if (value instanceof Double && !Double.isFinite((Double) value)
                    || value instanceof Float && !Float.isFinite((Float) value)) throw invalidState();
            budget.add(value.toString());
            return value;
        }
        if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) throw invalidState();
        if (visiting.put(value, Boolean.TRUE) != null) throw invalidState();
        try {
            if (value instanceof JSONObject) {
                JSONObject copy = new JSONObject();
                JSONObject source = (JSONObject) value;
                Iterator<String> keys = source.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (isForbiddenField(key)) throw new IOException("Credentials cannot be stored in chat state.");
                    budget.add(key);
                    copy.put(key, copyValue(source.get(key), depth + 1, visiting, budget));
                }
                return copy;
            }
            JSONArray source = (JSONArray) value;
            JSONArray copy = new JSONArray();
            int length = source.length();
            if (length > MAX_VALUES) throw invalidState();
            for (int index = 0; index < length; index++) {
                copy.put(copyValue(source.get(index), depth + 1, visiting, budget));
            }
            return copy;
        } finally {
            visiting.remove(value);
        }
    }

    private static IOException invalidState() {
        return new IOException("Invalid or oversized local chat state.");
    }

    private static final class Budget {
        int values;
        int bytes;

        void add(String value) throws IOException {
            bytes += encodeUtf8(value, MAX_BYTES - bytes).length;
            if (bytes > MAX_BYTES) throw invalidState();
        }
    }

    /** Reject JSONTokener's extensions and excessive depth before it can recurse. */
    private static final class JsonPolicyScanner {
        private final String source;
        private int position;
        private int values;

        JsonPolicyScanner(String source) { this.source = source; }

        void validate() throws IOException {
            value(0);
            whitespace();
            if (position != source.length()) throw invalidState();
        }

        private void value(int depth) throws IOException {
            if (depth > MAX_DEPTH || ++values > MAX_VALUES) throw invalidState();
            whitespace();
            char current = peek();
            if (current == '{') {
                position++;
                whitespace();
                if (take('}')) return;
                do {
                    whitespace();
                    string();
                    whitespace();
                    expect(':');
                    value(depth + 1);
                    whitespace();
                    if (take('}')) return;
                    expect(',');
                } while (true);
            } else if (current == '[') {
                position++;
                whitespace();
                if (take(']')) return;
                do {
                    value(depth + 1);
                    whitespace();
                    if (take(']')) return;
                    expect(',');
                } while (true);
            } else if (current == '"') {
                string();
            } else if (current == 't') {
                literal("true");
            } else if (current == 'f') {
                literal("false");
            } else if (current == 'n') {
                literal("null");
            } else {
                number();
            }
        }

        private void string() throws IOException {
            expect('"');
            while (position < source.length()) {
                char current = source.charAt(position++);
                if (current == '"') return;
                if (current < 0x20) throw invalidState();
                if (current == '\\') {
                    if (position >= source.length()) throw invalidState();
                    char escaped = source.charAt(position++);
                    if (escaped == 'u') {
                        for (int index = 0; index < 4; index++) {
                            char hex = peek();
                            if (!(hex >= '0' && hex <= '9' || hex >= 'a' && hex <= 'f'
                                    || hex >= 'A' && hex <= 'F')) throw invalidState();
                            position++;
                        }
                    } else if ("\"\\/bfnrt".indexOf(escaped) < 0) throw invalidState();
                }
            }
            throw invalidState();
        }

        private void number() throws IOException {
            take('-');
            if (take('0')) {
                if (digit(peek())) throw invalidState();
            } else {
                if (peek() < '1' || peek() > '9') throw invalidState();
                while (digit(peek())) position++;
            }
            if (take('.')) digits();
            if (take('e') || take('E')) {
                if (!take('+')) take('-');
                digits();
            }
        }

        private void digits() throws IOException {
            if (!digit(peek())) throw invalidState();
            while (digit(peek())) position++;
        }

        private void literal(String literal) throws IOException {
            if (!source.startsWith(literal, position)) throw invalidState();
            position += literal.length();
        }

        private void whitespace() {
            while (position < source.length() && " \n\r\t".indexOf(source.charAt(position)) >= 0) position++;
        }

        private char peek() { return position < source.length() ? source.charAt(position) : '\0'; }
        private boolean digit(char value) { return value >= '0' && value <= '9'; }
        private boolean take(char expected) {
            if (peek() != expected || position >= source.length()) return false;
            position++;
            return true;
        }
        private void expect(char expected) throws IOException { if (!take(expected)) throw invalidState(); }
    }
}
