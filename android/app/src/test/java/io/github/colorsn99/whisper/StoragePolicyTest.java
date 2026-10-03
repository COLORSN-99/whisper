package io.github.colorsn99.whisper;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Pure JVM policy tests. No Context, AndroidKeyStore, authorization, or network. */
public final class StoragePolicyTest {
    @Test public void providerAndConversationMetadataRoundTrip() throws Exception {
        JSONObject provider = new JSONObject().put("id", "provider_a").put("name", "自定义服务")
                .put("endpoint", "https://example.invalid/v1").put("credentialId", "provider_a")
                .put("models", new JSONArray().put("test-model"));
        JSONObject member = new JSONObject().put("id", "member_a").put("name", "小苇")
                .put("providerId", "provider_a").put("model", "test-model");
        JSONObject message = new JSONObject().put("id", "message_a").put("role", "user")
                .put("senderId", "user").put("senderName", "我").put("content", "你好 👋")
                .put("status", "done").put("createdAt", 1000);
        JSONObject chat = new JSONObject().put("id", "chat_a").put("title", "对话")
                .put("group", true).put("members", new JSONArray().put(member))
                .put("messages", new JSONArray().put(message)).put("updatedAt", 1000);
        JSONObject state = new JSONObject().put("version", 1)
                .put("providers", new JSONArray().put(provider))
                .put("chats", new JSONArray().put(chat)).put("selectedChatId", "chat_a");
        JSONObject loaded = LocalStore.decodeState(LocalStore.encodeState(state));
        assertEquals("provider_a", loaded.getJSONArray("providers").getJSONObject(0).getString("credentialId"));
        assertEquals("你好 👋", loaded.getJSONArray("chats").getJSONObject(0)
                .getJSONArray("messages").getJSONObject(0).getString("content"));
    }

    @Test public void sensitiveKeysAreRejectedThroughNestedObjectsAndArrays() throws Exception {
        String[] fields = {"apiKey", "access_token", "refresh_token", "id_token", "Authorization",
                "clientSecret", "secret", "password", "private_key", "credentials", "token",
                "cookies", "oauthCode", "codeVerifier", "client_assertion", "openaiApiKey",
                "api_token", "authToken", "bearer_token", "session_token"};
        for (String field : fields) {
            JSONObject state = new JSONObject().put("providers", new JSONArray()
                    .put(new JSONObject().put("settings", new JSONObject().put(field, "FAKE_TEST_SECRET"))));
            IOException failure = assertThrows(IOException.class, () -> LocalStore.encodeState(state));
            assertFalse(failure.getMessage().contains("FAKE_TEST_SECRET"));
            assertFalse(failure.getMessage().contains(field));
        }
    }

    @Test public void sensitiveFieldNormalizationCoversPunctuationCaseAndCompatibilityCharacters() {
        for (String field : new String[]{"API-KEY", "aPi KeY", "access.token", "REFRESH_TOKEN",
                "ａｐｉＫｅｙ", "api\u200bKey", "私有密钥", "密码"}) {
            assertTrue(LocalStore.isForbiddenField(field));
        }
        for (String field : new String[]{"provider", "providerId", "endpoint", "model", "models",
                "credentialId", "createdAt", "content", "status", "members", "tokenCount"}) {
            assertFalse(LocalStore.isForbiddenField(field));
        }
    }

    @Test public void fieldPolicyDoesNotPretendToRedactMessageContent() throws Exception {
        String content = "请解释 apiKey、Authorization 和 secret 字段。";
        JSONObject loaded = LocalStore.decodeState(LocalStore.encodeState(new JSONObject().put("content", content)));
        assertEquals(content, loaded.getString("content"));
    }

    @Test public void stateLimitUsesUtf8BytesAndIncludesJsonSyntax() throws Exception {
        JSONObject boundary = new JSONObject().put("text", "a".repeat(LocalStore.MAX_BYTES - 11));
        assertEquals(LocalStore.MAX_BYTES, LocalStore.encodeState(boundary).length);
        boundary.put("text", "a".repeat(LocalStore.MAX_BYTES - 10));
        assertThrows(IOException.class, () -> LocalStore.encodeState(boundary));
        JSONObject multibyte = new JSONObject().put("text", "界".repeat(LocalStore.MAX_BYTES / 3));
        assertThrows(IOException.class, () -> LocalStore.encodeState(multibyte));
    }

    @Test public void storedCredentialsAreRejectedWhileLoadingToo() {
        byte[] bytes = "{\"providers\":[{\"apiKey\":\"FAKE_DO_NOT_LOG\"}]}".getBytes(StandardCharsets.UTF_8);
        IOException failure = assertThrows(IOException.class, () -> LocalStore.decodeState(bytes));
        assertFalse(failure.getMessage().contains("FAKE_DO_NOT_LOG"));
    }

    @Test public void oversizedMalformedUtf8OrWrongRootStateIsRejected() {
        assertThrows(IOException.class, () -> LocalStore.decodeState(new byte[LocalStore.MAX_BYTES + 1]));
        assertThrows(IOException.class, () -> LocalStore.decodeState(new byte[]{(byte) 0xc3, 0x28}));
        for (String malformed : new String[]{"[]", "null", "{} {}", "{", "{\"text\":\"line\nfeed\"}",
                "{'unquoted':'value'}", "{/*comment*/\"x\":1}", "{unquoted:1}", "{\"x\":01}",
                "{\"x\":NaN}", "{\"x\":.5}", "{\"x\":1.}", "{\"x\":+1}", "{\"x\":1e}",
                "{\"x\":true,}", "{\"x\":[1,]}", "{\"x\":\"\\q\"}", "{}\u0000"}) {
            assertThrows(IOException.class, () -> LocalStore.decodeState(malformed.getBytes(StandardCharsets.UTF_8)));
        }
    }

    @Test public void deepAndCyclicInMemoryTreesAreRejected() throws Exception {
        JSONObject deep = new JSONObject();
        JSONObject cursor = deep;
        for (int depth = 0; depth <= LocalStore.MAX_DEPTH; depth++) {
            JSONObject next = new JSONObject();
            cursor.put("next", next);
            cursor = next;
        }
        assertThrows(IOException.class, () -> LocalStore.encodeState(deep));
        JSONObject cyclic = new JSONObject();
        cyclic.put("self", cyclic);
        assertThrows(IOException.class, () -> LocalStore.encodeState(cyclic));
    }

    @Test public void parserDepthIsBoundedBeforeJsonTokenerRecurses() {
        String deep = "{\"list\":" + "[".repeat(10_000) + "0" + "]".repeat(10_000) + "}";
        assertThrows(IOException.class, () -> LocalStore.decodeState(deep.getBytes(StandardCharsets.UTF_8)));
        String confusingUnquotedKeys = "{x\":" + "[".repeat(10_000) + "0" + "]".repeat(10_000) + ",y\":1}";
        assertThrows(IOException.class, () -> LocalStore.decodeState(confusingUnquotedKeys.getBytes(StandardCharsets.UTF_8)));
    }

    @Test public void bracesSlashesAndEscapedQuotesInsideStringsDoNotCountAsDepth() throws Exception {
        String content = "[[[{{{ https://example.invalid/ ' quote: \" and backslash: \\";
        JSONObject loaded = LocalStore.decodeState(LocalStore.encodeState(new JSONObject().put("content", content)));
        assertEquals(content, loaded.getString("content"));
    }

    @Test public void invalidUnicodeAndUnsupportedObjectsAreRejected() throws Exception {
        JSONObject unicode = new JSONObject().put("text", "\ud800");
        assertThrows(IOException.class, () -> LocalStore.encodeState(unicode));
        JSONObject unknown = new JSONObject().put("value", new Object());
        assertThrows(IOException.class, () -> LocalStore.encodeState(unknown));
    }

    @Test public void sharedNoncyclicObjectsAreAllowedAndEncodedSnapshotIsIndependent() throws Exception {
        JSONObject child = new JSONObject().put("title", "before");
        JSONObject state = new JSONObject().put("first", child).put("second", child);
        byte[] encoded = LocalStore.encodeState(state);
        child.put("title", "after");
        JSONObject loaded = LocalStore.decodeState(encoded);
        assertEquals("before", loaded.getJSONObject("first").getString("title"));
        assertEquals("before", loaded.getJSONObject("second").getString("title"));
    }

    @Test public void streamReaderRejectsEvenOneByteOverItsLimit() throws Exception {
        assertEquals(16, LocalStore.readBounded(new ByteArrayInputStream(new byte[16]), 16).length);
        assertThrows(IOException.class, () -> LocalStore.readBounded(new ByteArrayInputStream(new byte[17]), 16));
    }

    @Test public void commitVerificationRejectsStaleTruncatedOrMissingBytes() throws Exception {
        byte[] expected = "new committed state".getBytes(StandardCharsets.UTF_8);
        LocalStore.verifyStoredBytes(expected, expected.clone());
        assertThrows(IOException.class, () -> LocalStore.verifyStoredBytes(expected,
                "old committed state".getBytes(StandardCharsets.UTF_8)));
        assertThrows(IOException.class, () -> LocalStore.verifyStoredBytes(expected,
                Arrays.copyOf(expected, expected.length - 1)));
        assertThrows(IOException.class, () -> LocalStore.verifyStoredBytes(expected, null));
        assertThrows(IOException.class, () -> LocalStore.verifyStoredBytes(null, null));
    }

    @Test public void identifiersAreBoundedAndCannotBecomePaths() {
        for (String id : new String[]{"a", "provider_A-12", "A".repeat(128),
                "instrumentation_11111111-1111-1111-1111-111111111111"}) {
            CredentialStore.validateId(id);
        }
        for (String id : new String[]{null, "", ".", "..", "../escape", "a/b", "a\\b", "/absolute",
                "_initial", "a:alias", " a", "a\n", "Ａ", "a".repeat(129)}) {
            assertThrows(IllegalArgumentException.class, () -> CredentialStore.validateId(id));
        }
    }

    @Test public void recordNamesAndAliasesAreStableAndScopedToAnId() {
        assertEquals("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb.bin",
                CredentialStore.recordName("a"));
        assertTrue(CredentialStore.recordName("provider_a").matches("[0-9a-f]{64}\\.bin"));
        assertNotEquals(CredentialStore.recordName("provider_a"), CredentialStore.recordName("provider_b"));
        assertNotEquals(CredentialStore.aliasFor("provider_a"), CredentialStore.aliasFor("provider_b"));
        assertTrue(CredentialStore.aliasFor("provider_a").startsWith("io.github.colorsn99.whisper.credentials.v1."));
    }

    @Test public void aadIsUnambiguousAndBindsIdAndVersion() {
        assertArrayEquals(CredentialStore.aadFor("provider_a", 1), CredentialStore.aadFor("provider_a", 1));
        assertFalse(Arrays.equals(CredentialStore.aadFor("provider_a", 1), CredentialStore.aadFor("provider_b", 1)));
        assertFalse(Arrays.equals(CredentialStore.aadFor("provider_a", 1), CredentialStore.aadFor("provider_a", 2)));
        assertFalse(Arrays.equals(CredentialStore.aadFor("a1", 2), CredentialStore.aadFor("a", 12)));
    }

    @Test public void boundedBinaryRecordsRoundTrip() throws Exception {
        byte[] iv = new byte[CredentialStore.IV_BYTES];
        byte[] ciphertext = new byte[CredentialStore.MAX_SECRET_BYTES + CredentialStore.TAG_BYTES];
        Arrays.fill(iv, (byte) 3);
        Arrays.fill(ciphertext, (byte) 7);
        byte[] encoded = CredentialStore.encodeRecord(iv, ciphertext);
        assertEquals(CredentialStore.MAX_RECORD_BYTES, encoded.length);
        CredentialStore.Record decoded = CredentialStore.decodeRecord(encoded);
        assertArrayEquals(iv, decoded.iv);
        assertArrayEquals(ciphertext, decoded.ciphertext);
    }

    @Test public void recordsRejectUnknownVersionsTruncationAppendagesAndInvalidLengths() throws Exception {
        byte[] record = CredentialStore.encodeRecord(new byte[12], new byte[17]);
        byte[] version = record.clone();
        ByteBuffer.wrap(version).putInt(4, 2);
        byte[] magic = record.clone();
        magic[0] ^= 1;
        byte[] negativeLength = record.clone();
        ByteBuffer.wrap(negativeLength).putInt(20, -1);
        for (byte[] bad : new byte[][]{null, new byte[0], version, magic, negativeLength,
                Arrays.copyOf(record, record.length - 1), Arrays.copyOf(record, record.length + 1),
                new byte[CredentialStore.MAX_RECORD_BYTES + 1]}) {
            assertThrows(IOException.class, () -> CredentialStore.decodeRecord(bad));
        }
        assertThrows(IOException.class, () -> CredentialStore.encodeRecord(new byte[11], new byte[17]));
        assertThrows(IOException.class, () -> CredentialStore.encodeRecord(new byte[12], new byte[15]));
        assertThrows(IOException.class, () -> CredentialStore.encodeRecord(new byte[12],
                new byte[CredentialStore.MAX_SECRET_BYTES + CredentialStore.TAG_BYTES + 1]));
    }

    @Test public void secretEncodingIsStrictAndBoundedInBothDirections() throws Exception {
        char[] fake = "FAKE_测试_🙂".toCharArray();
        assertArrayEquals(fake, CredentialStore.decodeSecret(CredentialStore.encodeSecret(fake)));
        char[] boundary = "a".repeat(CredentialStore.MAX_SECRET_BYTES).toCharArray();
        assertEquals(CredentialStore.MAX_SECRET_BYTES, CredentialStore.encodeSecret(boundary).length);
        assertThrows(IOException.class, () -> CredentialStore.encodeSecret(new char[0]));
        assertThrows(IOException.class, () -> CredentialStore.encodeSecret(new char[]{'\ud800'}));
        assertThrows(IOException.class, () -> CredentialStore.encodeSecret(
                "界".repeat(CredentialStore.MAX_SECRET_BYTES / 3 + 1).toCharArray()));
        assertThrows(IOException.class, () -> CredentialStore.decodeSecret(new byte[0]));
        assertThrows(IOException.class, () -> CredentialStore.decodeSecret(new byte[]{(byte) 0xc3, 0x28}));
        assertThrows(IOException.class, () -> CredentialStore.decodeSecret(new byte[CredentialStore.MAX_SECRET_BYTES + 1]));
    }

    @Test public void restoreAlwaysRequiresItsOwnExplicitConsent() throws Exception {
        assertThrows(GeneralSecurityException.class, () -> CredentialStore.requireRestoreConsent(false));
        CredentialStore.requireRestoreConsent(true);
    }

    @Test public void gcmAuthenticationRejectsRecordTransplantAndCiphertextTampering() throws Exception {
        // Local JCE with a synthetic test key, never AndroidKeyStore or real credentials.
        SecretKeySpec key = new SecretKeySpec(new byte[32], "AES");
        byte[] iv = new byte[12];
        byte[] plaintext = "ONLY_A_FAKE_TEST_VALUE".getBytes(StandardCharsets.UTF_8);
        Cipher encryption = Cipher.getInstance("AES/GCM/NoPadding");
        encryption.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        encryption.updateAAD(CredentialStore.aadFor("provider_a", 1));
        byte[] ciphertext = encryption.doFinal(plaintext);
        assertArrayEquals(plaintext, decryptFake(key, iv, ciphertext, "provider_a", 1));
        assertThrows(GeneralSecurityException.class, () -> decryptFake(key, iv, ciphertext, "provider_b", 1));
        assertThrows(GeneralSecurityException.class, () -> decryptFake(key, iv, ciphertext, "provider_a", 2));
        ciphertext[0] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> decryptFake(key, iv, ciphertext, "provider_a", 1));
    }

    private static byte[] decryptFake(SecretKeySpec key, byte[] iv, byte[] ciphertext, String id, int version)
            throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        cipher.updateAAD(CredentialStore.aadFor(id, version));
        return cipher.doFinal(ciphertext);
    }
}
