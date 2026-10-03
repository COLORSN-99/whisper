package io.github.colorsn99.whisper;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * App-local credentials. Construction never reads credentials or AndroidKeyStore.
 * Persist and restore require separate UI consent. Intended for one app process.
 * char[] and temporary bytes are cleared on a best-effort basis; returned Strings
 * and platform cryptographic internals cannot be reliably erased by Java.
 */
public final class CredentialStore implements AutoCloseable {
    static final int RECORD_VERSION = 1;
    static final int IV_BYTES = 12;
    static final int TAG_BYTES = 16;
    static final int MAX_SECRET_BYTES = 64 * 1024;
    static final int MAX_RECORD_BYTES = 4 + 4 + IV_BYTES + 4 + MAX_SECRET_BYTES + TAG_BYTES;
    private static final int MAGIC = 0x57435231; // WCR1
    private static final String ALIAS_PREFIX = "io.github.colorsn99.whisper.credentials.v1.";
    private static final Object PERSISTENCE_LOCK = new Object();
    private final File directory;
    private final Map<String, char[]> memory = new HashMap<>();
    private boolean closed;

    public CredentialStore(Context context) {
        directory = new File(context.getNoBackupFilesDir(), "credentials-v1");
    }

    /** Looks only in this instance's memory; it never implicitly restores a record. */
    public synchronized String get(String id) {
        checkOpen();
        validateId(id);
        char[] value = memory.get(id);
        return value == null ? null : new String(value);
    }

    public synchronized void put(String id, String secret, boolean persist)
            throws IOException, GeneralSecurityException {
        checkOpen();
        validateId(id);
        if (secret == null || secret.isEmpty() || secret.length() > MAX_SECRET_BYTES) {
            throw new IllegalArgumentException("Invalid credential value.");
        }
        char[] candidate = secret.toCharArray();
        byte[] plaintext = null;
        boolean retained = false;
        try {
            plaintext = encodeSecret(candidate);
            if (persist) {
                persist(id, plaintext);
            } else {
                // A successful switch to memory-only also revokes old persistence.
                deletePersisted(id);
            }
            replaceMemory(id, candidate);
            retained = true;
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (!retained) Arrays.fill(candidate, '\0');
        }
    }

    public synchronized String restore(String id, boolean consent)
            throws IOException, GeneralSecurityException {
        checkOpen();
        requireRestoreConsent(consent);
        validateId(id);
        synchronized (PERSISTENCE_LOCK) {
            return restoreAuthorized(id);
        }
    }

    private String restoreAuthorized(String id) throws IOException, GeneralSecurityException {
        File file = recordFile(id);
        if (!recordExists(file)) return null;
        Record record;
        try (FileInputStream input = new AtomicFile(file).openRead()) {
            record = decodeRecord(LocalStore.readBounded(input, MAX_RECORD_BYTES));
        }
        // Deliberately never call the key-generation path while restoring.
        SecretKey key = existingKey(openKeyStore(), aliasFor(id));
        if (key == null) throw new GeneralSecurityException("The stored credential key is unavailable.");
        byte[] plaintext = null;
        char[] decoded = null;
        boolean retained = false;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BYTES * 8, record.iv));
            cipher.updateAAD(aadFor(id, RECORD_VERSION));
            plaintext = cipher.doFinal(record.ciphertext);
            decoded = decodeSecret(plaintext);
            replaceMemory(id, decoded);
            retained = true;
            return new String(decoded);
        } catch (GeneralSecurityException failure) {
            throw new GeneralSecurityException("Unable to authenticate the stored credential.");
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (!retained && decoded != null) Arrays.fill(decoded, '\0');
        }
    }

    /** Checks only this ID's encrypted record, without loading a key or plaintext. */
    public synchronized boolean hasPersisted(String id) {
        checkOpen();
        validateId(id);
        synchronized (PERSISTENCE_LOCK) {
            return recordExists(recordFile(id));
        }
    }

    public synchronized void remove(String id) throws IOException, GeneralSecurityException {
        checkOpen();
        validateId(id);
        char[] previous = memory.remove(id);
        if (previous != null) Arrays.fill(previous, '\0');
        deletePersisted(id);
    }

    @Override
    public synchronized void close() {
        for (char[] value : memory.values()) Arrays.fill(value, '\0');
        memory.clear();
        closed = true;
    }

    static void requireRestoreConsent(boolean consent) throws GeneralSecurityException {
        if (!consent) throw new GeneralSecurityException("Restoring a credential requires explicit consent.");
    }

    static void validateId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,127}")) {
            throw new IllegalArgumentException("Invalid credential identifier.");
        }
    }

    static String recordName(String id) {
        validateId(id);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.US_ASCII));
            StringBuilder result = new StringBuilder(64);
            for (byte value : digest) {
                result.append(Character.forDigit((value >>> 4) & 15, 16));
                result.append(Character.forDigit(value & 15, 16));
            }
            return result + ".bin";
        } catch (GeneralSecurityException impossible) {
            throw new IllegalStateException("Required digest is unavailable.");
        }
    }

    static String aliasFor(String id) {
        String name = recordName(id);
        return ALIAS_PREFIX + name.substring(0, name.length() - 4);
    }

    static byte[] aadFor(String id, int version) {
        validateId(id);
        byte[] domain = "Whisper/CredentialStore".getBytes(StandardCharsets.US_ASCII);
        byte[] identifier = id.getBytes(StandardCharsets.US_ASCII);
        return ByteBuffer.allocate(domain.length + 8 + identifier.length)
                .put(domain).putInt(version).putInt(identifier.length).put(identifier).array();
    }

    static byte[] encodeRecord(byte[] iv, byte[] ciphertext) throws IOException {
        if (iv == null || iv.length != IV_BYTES || ciphertext == null
                || ciphertext.length < TAG_BYTES || ciphertext.length > MAX_SECRET_BYTES + TAG_BYTES) {
            throw invalidRecord();
        }
        return ByteBuffer.allocate(4 + 4 + IV_BYTES + 4 + ciphertext.length)
                .putInt(MAGIC).putInt(RECORD_VERSION).put(iv).putInt(ciphertext.length).put(ciphertext).array();
    }

    static Record decodeRecord(byte[] encoded) throws IOException {
        if (encoded == null || encoded.length < 4 + 4 + IV_BYTES + 4 + TAG_BYTES
                || encoded.length > MAX_RECORD_BYTES) throw invalidRecord();
        ByteBuffer buffer = ByteBuffer.wrap(encoded);
        if (buffer.getInt() != MAGIC || buffer.getInt() != RECORD_VERSION) throw invalidRecord();
        byte[] iv = new byte[IV_BYTES];
        buffer.get(iv);
        int length = buffer.getInt();
        if (length < TAG_BYTES || length != buffer.remaining()) throw invalidRecord();
        byte[] ciphertext = new byte[length];
        buffer.get(ciphertext);
        return new Record(iv, ciphertext);
    }

    static byte[] encodeSecret(char[] secret) throws IOException {
        if (secret == null || secret.length == 0 || secret.length > MAX_SECRET_BYTES) throw invalidRecord();
        ByteBuffer buffer = null;
        try {
            buffer = StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(secret));
            if (buffer.remaining() > MAX_SECRET_BYTES) throw invalidRecord();
            byte[] result = new byte[buffer.remaining()];
            buffer.get(result);
            return result;
        } catch (CharacterCodingException failure) {
            throw invalidRecord();
        } finally {
            if (buffer != null && buffer.hasArray()) Arrays.fill(buffer.array(), (byte) 0);
        }
    }

    static char[] decodeSecret(byte[] plaintext) throws IOException {
        if (plaintext == null || plaintext.length == 0 || plaintext.length > MAX_SECRET_BYTES) throw invalidRecord();
        CharBuffer buffer = null;
        try {
            buffer = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plaintext));
            char[] result = new char[buffer.remaining()];
            buffer.get(result);
            return result;
        } catch (CharacterCodingException failure) {
            throw invalidRecord();
        } finally {
            if (buffer != null && buffer.hasArray()) Arrays.fill(buffer.array(), '\0');
        }
    }

    private void persist(String id, byte[] plaintext) throws IOException, GeneralSecurityException {
        synchronized (PERSISTENCE_LOCK) {
            persistLocked(id, plaintext);
        }
    }

    private void persistLocked(String id, byte[] plaintext) throws IOException, GeneralSecurityException {
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("Unable to create private credential storage.");
        }
        KeyStore keyStore = openKeyStore();
        String alias = aliasFor(id);
        SecretKey key = existingKey(keyStore, alias);
        boolean created = false;
        if (key == null) {
            // Refuse to replace a missing key for an existing encrypted record.
            if (recordExists(recordFile(id))) {
                throw new GeneralSecurityException("Remove the unavailable credential before saving a replacement.");
            }
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true).build());
            key = generator.generateKey();
            created = true;
        }
        boolean finishReturned = false;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            cipher.updateAAD(aadFor(id, RECORD_VERSION));
            byte[] record = encodeRecord(cipher.getIV(), cipher.doFinal(plaintext));
            AtomicFile target = new AtomicFile(recordFile(id));
            FileOutputStream output = null;
            try {
                output = target.startWrite();
                output.write(record);
                output.getFD().sync();
                target.finishWrite(output);
                output = null;
                finishReturned = true;
            } catch (IOException | RuntimeException failure) {
                if (output != null) target.failWrite(output);
                throw new IOException("Unable to save encrypted credentials.");
            }
            // A read-back failure leaves commit status uncertain. Keep any new
            // key so a possibly committed record is not made unrecoverable.
            try (FileInputStream input = target.openRead()) {
                LocalStore.verifyStoredBytes(record, LocalStore.readBounded(input, MAX_RECORD_BYTES));
            } catch (IOException | RuntimeException failure) {
                throw new IOException("Unable to verify saved encrypted credentials.");
            }
        } finally {
            if (created && !finishReturned) keyStore.deleteEntry(alias);
        }
    }

    private void deletePersisted(String id) throws IOException, GeneralSecurityException {
        synchronized (PERSISTENCE_LOCK) {
            deletePersistedLocked(id);
        }
    }

    private void deletePersistedLocked(String id) throws IOException, GeneralSecurityException {
        File file = recordFile(id);
        IOException fileFailure = null;
        try {
            new AtomicFile(file).delete();
            if (file.exists() || new File(file.getPath() + ".bak").exists()
                    || new File(file.getPath() + ".new").exists()) {
                fileFailure = new IOException("Unable to remove the encrypted credential record.");
            }
        } catch (RuntimeException failure) {
            fileFailure = new IOException("Unable to remove the encrypted credential record.");
        }
        // Try key revocation even if file removal failed; never enumerate other aliases.
        try {
            openKeyStore().deleteEntry(aliasFor(id));
        } catch (IOException | GeneralSecurityException failure) {
            if (fileFailure != null) failure.addSuppressed(fileFailure);
            throw failure;
        }
        if (fileFailure != null) throw fileFailure;
    }

    private static KeyStore openKeyStore() throws IOException, GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        return keyStore;
    }

    private static SecretKey existingKey(KeyStore keyStore, String alias) throws GeneralSecurityException {
        Key key = keyStore.getKey(alias, null);
        if (key == null) return null;
        if (!(key instanceof SecretKey)) throw new GeneralSecurityException("Unexpected credential key type.");
        return (SecretKey) key;
    }

    private File recordFile(String id) {
        return new File(directory, recordName(id));
    }

    private static boolean recordExists(File file) {
        return file.exists() || new File(file.getPath() + ".bak").exists();
    }

    private void replaceMemory(String id, char[] value) {
        char[] previous = memory.put(id, value);
        if (previous != null) Arrays.fill(previous, '\0');
    }

    private void checkOpen() {
        if (closed) throw new IllegalStateException("Credential store is closed.");
    }

    private static IOException invalidRecord() {
        return new IOException("Invalid or oversized encrypted credential data.");
    }

    static final class Record {
        final byte[] iv;
        final byte[] ciphertext;

        Record(byte[] iv, byte[] ciphertext) {
            this.iv = iv;
            this.ciphertext = ciphertext;
        }
    }
}
