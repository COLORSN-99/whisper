package io.github.colorsn99.whisper;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Configurator;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.UiScrollable;
import androidx.test.uiautomator.UiSelector;
import androidx.test.uiautomator.Until;

import org.json.JSONArray;
import org.json.JSONObject;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TestName;
import org.junit.runner.RunWith;

import java.io.File;
import java.security.GeneralSecurityException;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/** Runs only on a fresh CI emulator, with local demo data and newly generated fake secrets. */
@RunWith(AndroidJUnit4.class)
public final class WhisperInstrumentedTest {
    private static final long UI_TIMEOUT_MS = 15000;
    @Rule public final TestName testName = new TestName();

    private Context context;
    private UiDevice device;
    private ActivityScenario<MainActivity> scenario;
    private boolean captureScreenshot;
    private long previousIdleTimeout;

    @Before public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        previousIdleTimeout = Configurator.getInstance().getWaitForIdleTimeout();
        // Streaming text deliberately keeps emitting events; explicit Until waits replace idle waits.
        Configurator.getInstance().setWaitForIdleTimeout(0);
    }

    @After public void tearDown() throws Exception {
        try {
            if (scenario != null && captureScreenshot) {
                File directory = context.getExternalFilesDir("instrumentation-screenshots");
                assertNotNull("App-specific screenshot storage must be available", directory);
                assertTrue("Create the app-specific screenshot directory", directory.isDirectory() || directory.mkdirs());
                assertTrue("Capture the current local demo UI",
                        device.takeScreenshot(new File(directory, testName.getMethodName() + ".png")));
            }
        } finally {
            try {
                if (scenario != null) scenario.close();
            } finally {
                Configurator.getInstance().setWaitForIdleTimeout(previousIdleTimeout);
            }
        }
    }

    @Test public void launchesLocalConversationsWithoutAMacOrLogin() {
        launchApp();
        requireText("小苇");
        requireText("灵感群聊");
        openChat("小苇");
        waitForGenerationStatus("离线演示 · 就绪");
        assertTrue(requireId("message_input").isEnabled());
    }

    @Test public void privateDemoReplyCanBeStoppedAndTheNextReplyCompletes() {
        launchApp();
        openChat("小苇");
        String stoppedMessage = "停止验收_" + UUID.randomUUID() + "：请逐步展开这个离线演示想法。";
        sendMessage(stoppedMessage);
        assertTrue("The local demo must enter its streaming state before stopping",
                device.wait(Until.hasObject(By.res(context.getPackageName(), "generation_status").textContains("正在回复")), UI_TIMEOUT_MS));
        UiObject2 stop = requireId("stop_generation");
        assertTrue("The running demo exposes an enabled stop action", stop.isEnabled());
        stop.click();
        waitForGenerationStatus("已停止");
        assertTrue(requireId("message_input").isEnabled());
        assertTrue(messageText().contains(stoppedMessage));

        String nextMessage = "继续验收_" + UUID.randomUUID();
        sendMessage(nextMessage);
        waitForGenerationStatus("回复完成");
        String messages = messageText();
        assertTrue(messages.contains(stoppedMessage));
        assertTrue(messages.contains(nextMessage));
        assertTrue("The local assistant remains identified", messages.contains("小苇"));
    }

    @Test public void groupMembersAndMessagesSurviveActivityRelaunch() throws Exception {
        launchApp();
        openChat("灵感群聊");
        assertDefaultGroupMembers();
        String marker = "群聊记录验收_" + UUID.randomUUID();
        sendMessage(marker);
        waitForGenerationStatus("回复完成");
        String before = messageText();
        assertTrue(before.contains(marker));
        assertTrue(before.contains("小苇"));
        assertTrue(before.contains("阿澄"));
        waitForCommittedGroupReplies(marker);

        scenario.close();
        scenario = null;
        assertTrue("A new store reads the unique message from the committed local file",
                new LocalStore(context).load().toString().contains(marker));
        launchApp();
        openChat("灵感群聊");
        String restored = messageText();
        assertTrue("The unique message is read back after a new Activity launch", restored.contains(marker));
        assertTrue(restored.contains("小苇"));
        assertTrue(restored.contains("阿澄"));
        assertTrue("The complete rendered transcript survives relaunch", before.equals(restored));
        assertDefaultGroupMembers();
    }

    @Test public void providerCredentialPersistenceStartsUnchecked() throws Exception {
        launchApp();
        captureScreenshot = false; // Credential dialogs intentionally prohibit screenshots.
        requireId("settings").click();
        requireId("provider_add").click();
        requireId("provider_name");
        new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(
                new UiSelector().resourceId(context.getPackageName() + ":id/save_credential"));
        UiObject2 persist = requireId("save_credential");
        assertTrue("Persistence is an explicit checkbox", persist.isCheckable());
        assertFalse("Opening provider setup must default to memory-only", persist.isChecked());
    }

    @Test public void memoryOnlyCredentialsDoNotSurviveAStoreRestart() throws Exception {
        String id = uniqueId("memory");
        String secret = "instrumentation_fake_memory_" + UUID.randomUUID();
        CredentialStore first = new CredentialStore(context);
        CredentialStore reopened = null;
        try {
            first.put(id, secret, false);
            assertTrue("Memory contains the supplied fake value", secret.equals(first.get(id)));
            assertFalse(first.hasPersisted(id));
            first.close();
            reopened = new CredentialStore(context);
            assertNull(reopened.get(id));
            assertFalse(reopened.hasPersisted(id));
        } finally {
            first.close();
            if (reopened == null) reopened = new CredentialStore(context);
            try { reopened.remove(id); } finally { reopened.close(); }
        }
    }

    @Test public void persistedCredentialsRequireAnExplicitRestoreDecision() throws Exception {
        String id = uniqueId("persist");
        String secret = "instrumentation_fake_persist_" + UUID.randomUUID();
        CredentialStore first = new CredentialStore(context);
        CredentialStore reopened = null;
        try {
            first.put(id, secret, true);
            assertTrue(first.hasPersisted(id));
            first.close();
            reopened = new CredentialStore(context);
            assertTrue(reopened.hasPersisted(id));
            assertNull("Construction never restores a persisted secret", reopened.get(id));
            try {
                reopened.restore(id, false);
                fail("Restoration without consent must be rejected");
            } catch (GeneralSecurityException expected) {
                // A denied decision is an expected outcome, not a prompt to retry automatically.
            }
            assertNull("Declining restoration cannot activate a secret", reopened.get(id));
            assertTrue("Consented restoration returns the supplied fake value", secret.equals(reopened.restore(id, true)));
            assertTrue("Consented restoration activates the value in memory", secret.equals(reopened.get(id)));
            reopened.remove(id);
            assertFalse(reopened.hasPersisted(id));
            assertNull(reopened.get(id));
        } finally {
            first.close();
            if (reopened == null) reopened = new CredentialStore(context);
            try { reopened.remove(id); } finally { reopened.close(); }
        }
    }

    @Test public void switchingBackToMemoryOnlyRemovesTheOldPersistedSecret() throws Exception {
        String id = uniqueId("downgrade");
        CredentialStore first = new CredentialStore(context);
        CredentialStore reopened = null;
        try {
            first.put(id, "instrumentation_fake_saved_" + UUID.randomUUID(), true);
            assertTrue(first.hasPersisted(id));
            String memorySecret = "instrumentation_fake_temporary_" + UUID.randomUUID();
            first.put(id, memorySecret, false);
            assertTrue("The replacement remains available in memory", memorySecret.equals(first.get(id)));
            assertFalse("An old saved value must not be recoverable after opting out", first.hasPersisted(id));
            first.close();
            reopened = new CredentialStore(context);
            assertNull(reopened.get(id));
            assertFalse(reopened.hasPersisted(id));
        } finally {
            first.close();
            if (reopened == null) reopened = new CredentialStore(context);
            try { reopened.remove(id); } finally { reopened.close(); }
        }
    }

    private static String uniqueId(String prefix) {
        return "instrumentation_" + prefix + "_" + UUID.randomUUID();
    }

    private UiObject2 requireId(String name) {
        UiObject2 object = device.wait(Until.findObject(By.res(context.getPackageName(), name)), UI_TIMEOUT_MS);
        assertNotNull("Expected visible UI resource: " + name, object);
        return object;
    }

    private UiObject2 requireText(String text) {
        UiObject2 object = device.wait(Until.findObject(By.text(text)), UI_TIMEOUT_MS);
        assertNotNull("Expected local demo UI text: " + text, object);
        return object;
    }

    private void launchApp() {
        scenario = ActivityScenario.launch(MainActivity.class);
        captureScreenshot = true;
        requireId("chat_list");
    }

    private void openChat(String title) {
        requireText(title).click();
        requireId("message_input");
    }

    private void sendMessage(String text) {
        requireId("message_input").setText(text);
        requireId("send_message").click();
    }

    private void waitForGenerationStatus(String text) {
        assertTrue("Expected local generation status: " + text,
                device.wait(Until.hasObject(By.res(context.getPackageName(), "generation_status").text(text)), UI_TIMEOUT_MS));
    }

    private String messageText() {
        requireId("messages");
        AtomicReference<String> result = new AtomicReference<>();
        // Read the rendered native view tree, including bubbles above the scroll viewport.
        scenario.onActivity(activity -> {
            View messages = activity.findViewById(R.id.messages);
            assertNotNull("The conversation contains a native message view", messages);
            result.set(collectViewText(messages));
        });
        return result.get();
    }

    private void assertDefaultGroupMembers() {
        requireId("member_settings").click();
        String members = collectText(requireId("member_list"));
        assertTrue(members.contains("小苇"));
        assertTrue(members.contains("阿澄"));
        device.pressBack();
        requireId("message_input");
    }

    private void waitForCommittedGroupReplies(String marker) throws Exception {
        long deadline = SystemClock.uptimeMillis() + UI_TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline) {
            JSONArray chats = new LocalStore(context).load().optJSONArray("chats");
            if (chats != null) for (int index = 0; index < chats.length(); index++) {
                JSONArray messages = chats.getJSONObject(index).optJSONArray("messages");
                if (messages == null) continue;
                boolean foundUser = false, foundFirst = false, foundSecond = false;
                for (int item = 0; item < messages.length(); item++) {
                    JSONObject message = messages.getJSONObject(item);
                    if ("user".equals(message.optString("role")) && marker.equals(message.optString("content"))) {
                        foundUser = true;
                    } else if (foundUser && "assistant".equals(message.optString("role"))
                            && "complete".equals(message.optString("status"))) {
                        if ("小苇".equals(message.optString("senderName"))) foundFirst = true;
                        if ("阿澄".equals(message.optString("senderName"))) foundSecond = true;
                    }
                }
                if (foundUser && foundFirst && foundSecond) return;
            }
            SystemClock.sleep(25);
        }
        fail("Both local group replies must be committed before relaunching the Activity");
    }

    private static String collectText(UiObject2 object) {
        StringBuilder text = new StringBuilder();
        if (object.getText() != null) text.append(object.getText()).append('\n');
        for (UiObject2 child : object.getChildren()) text.append(collectText(child));
        return text.toString();
    }

    private static String collectViewText(View view) {
        StringBuilder text = new StringBuilder();
        if (view instanceof TextView) text.append(((TextView) view).getText()).append('\n');
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                text.append(collectViewText(group.getChildAt(index)));
            }
        }
        return text.toString();
    }
}
