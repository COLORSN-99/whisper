package io.github.colorsn99.whisper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Native, device-local chat UI. No WebView, local server, or device-control permissions. */
public final class MainActivity extends Activity {
    private static final int CREAM = Color.rgb(246, 245, 238);
    private static final int PAPER = Color.rgb(255, 254, 249);
    private static final int GREEN = Color.rgb(53, 107, 80);
    private static final int LEAF = Color.rgb(218, 235, 209);
    private static final int INK = Color.rgb(37, 57, 46);
    private static final int MUTED = Color.rgb(99, 118, 105);
    private static final int WARN = Color.rgb(153, 65, 43);
    private static final int MAX_MESSAGES = 300;
    private static final int MAX_REPLY_CHARS = 65536;
    private static final String DEMO = "demo";

    private final Handler main = new Handler(Looper.getMainLooper());
    // Ordered across Activity recreation: the previous instance's final save must
    // precede the next instance's load. No Activity is retained by this executor.
    private static final ExecutorService disk = Executors.newSingleThreadExecutor();
    private static CredentialStore processCredentials;
    private static final Set<String> updatingProviders = Collections.synchronizedSet(new HashSet<>());
    private final Map<String, TextView> messageViews = new HashMap<>();
    private final Map<String, TextView> messageStates = new HashMap<>();
    private LocalStore localStore;
    private CredentialStore credentials;
    private ChatClient client;
    private JSONObject state;
    private LinearLayout root;
    private LinearLayout messageList;
    private ScrollView messageScroll;
    private EditText composer;
    private Button sendButton;
    private Button stopButton;
    private TextView generationStatus;
    private TextView storageNotice;
    private String page = "home";
    private String selectedChatId = "";
    private String saveIssue = "";
    private String lastStatus = "";
    private boolean storageAvailable = true;
    private boolean destroyed;
    private boolean generating;
    private boolean stopping;
    private boolean saveScheduled;
    private String stopReason = "已停止";
    private long generation;
    private JSONObject activeChat;
    private JSONObject activeMessage;
    private JSONArray activeMembers;
    private int memberIndex;
    private ChatClient.Request request;
    private Runnable demoTick;
    private final Runnable delayedSave = () -> { saveScheduled = false; saveState(); };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else {
            int systemUi = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            // The API 26 base theme keeps a dark navigation bar with light icons.
            if (Build.VERSION.SDK_INT >= 27) systemUi |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            getWindow().getDecorView().setSystemUiVisibility(systemUi);
        }
        localStore = new LocalStore(this);
        synchronized (MainActivity.class) {
            if (processCredentials == null) processCredentials = new CredentialStore(getApplicationContext());
            credentials = processCredentials;
        }
        client = new ChatClient();
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        shell();
        root.addView(label("正在打开 whisper…", 18, INK), fill());
        final String restoredPage = savedInstanceState == null ? "home" : savedInstanceState.getString("page", "home");
        final String restoredChat = savedInstanceState == null ? "" : savedInstanceState.getString("chat", "");
        disk.execute(() -> {
            JSONObject loaded = null;
            boolean failed = false;
            try { loaded = localStore.load(); }
            catch (Exception error) { failed = true; }
            final JSONObject result = loaded;
            final boolean loadFailed = failed;
            runOnUiThread(() -> {
                if (destroyed) return;
                storageAvailable = !loadFailed;
                state = normalizeState(result);
                if (loadFailed) saveIssue = "未能读取本机记录。本次为临时体验，原记录不会被改写。";
                selectedChatId = restoredChat.isEmpty() ? state.optString("selectedChatId") : restoredChat;
                if ("chat".equals(restoredPage) && chat(selectedChatId) != null) showChat(selectedChatId);
                else showHome();
                saveState();
            });
        });
    }

    private JSONObject normalizeState(JSONObject source) {
        if (source == null || !source.has("chats")) return initialState();
        JSONArray chats = source.optJSONArray("chats");
        JSONArray providers = source.optJSONArray("providers");
        if (chats == null || providers == null) return initialState();
        // The local file is not an import format. Retain only known, credential-free fields.
        JSONObject clean = object("version", 1, "providers", new JSONArray(), "chats", new JSONArray(),
                "selectedChatId", source.optString("selectedChatId"));
        for (int i = 0; i < providers.length() && i < 20; i++) {
            JSONObject p = providers.optJSONObject(i);
            if (p == null || p.optString("id").isEmpty() || DEMO.equals(p.optString("id"))) continue;
            JSONArray models = p.optJSONArray("models");
            if (models == null || models.length() == 0) continue;
            array(clean, "providers").put(object("id", p.optString("id"), "name", p.optString("name"),
                    "endpoint", p.optString("endpoint"), "models", models));
        }
        for (int i = 0; i < chats.length() && i < 50; i++) {
            JSONObject c = chats.optJSONObject(i);
            if (c == null || c.optString("id").isEmpty()) continue;
            JSONArray members = new JSONArray();
            for (int j = 0; j < array(c, "members").length() && j < 6; j++) {
                JSONObject m = array(c, "members").optJSONObject(j);
                if (m == null) continue;
                members.put(object("id", m.optString("id", id()), "name", m.optString("name", "成员"),
                        "providerId", m.optString("providerId", DEMO), "model", m.optString("model", "demo-gentle")));
            }
            if (members.length() == 0) members.put(member("小苇", "demo-gentle"));
            JSONArray messages = new JSONArray();
            for (int j = 0; j < array(c, "messages").length() && j < MAX_MESSAGES; j++) {
                JSONObject m = array(c, "messages").optJSONObject(j);
                if (m == null) continue;
                String status = m.optString("status", "complete");
                if ("streaming".equals(status)) status = "interrupted";
                messages.put(object("id", m.optString("id", id()), "role", m.optString("role", "assistant"),
                        "senderId", m.optString("senderId"), "senderName", m.optString("senderName", "成员"),
                        "content", m.optString("content"), "status", status,
                        "mode", m.optString("mode", "demo"), "createdAt", m.optLong("createdAt")));
            }
            array(clean, "chats").put(object("id", c.optString("id"), "title", c.optString("title", "聊天"),
                    "group", c.optBoolean("group"), "members", members, "messages", messages,
                    "draft", c.optString("draft"), "updatedAt", c.optLong("updatedAt")));
        }
        return clean;
    }

    private JSONObject initialState() {
        JSONObject direct = conversation("小苇", false);
        array(direct, "messages").put(object("id", id(), "role", "assistant", "senderId", array(direct, "members").optJSONObject(0).optString("id"),
                "senderName", "小苇", "content", "你好，我是小苇。\n\n这里是离线演示，你可以试试发送消息、停止回复，或邀请多个成员一起聊。演示内容在设备本地生成，不会调用模型。", "status", "complete", "mode", "demo", "createdAt", System.currentTimeMillis()));
        return object("version", 1, "providers", new JSONArray(), "chats", new JSONArray().put(direct).put(conversation("灵感群聊", true)),
                "selectedChatId", direct.optString("id"));
    }

    private JSONObject conversation(String title, boolean group) {
        JSONArray members = new JSONArray().put(member("小苇", "demo-gentle"));
        if (group) members.put(member("阿澄", "demo-spark"));
        return object("id", id(), "title", title, "group", group, "members", members, "messages", new JSONArray(), "draft", "", "updatedAt", System.currentTimeMillis());
    }

    private JSONObject member(String name, String model) {
        return object("id", id(), "name", name, "providerId", DEMO, "model", model);
    }

    private void shell() {
        messageViews.clear(); messageStates.clear();
        composer = null; messageList = null; messageScroll = null; generationStatus = null; sendButton = null; stopButton = null;
        root = column(); root.setBackgroundColor(CREAM);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            } else v.setPadding(0, 0, 0, 0);
            return insets;
        });
        setContentView(root);
        root.requestApplyInsets();
    }

    private LinearLayout toolbar(String title, String subtitle, boolean back) {
        LinearLayout bar = row(); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(12), dp(8), dp(12), dp(8));
        if (back) {
            Button b = button("‹", R.id.back, false); b.setTextSize(28); b.setContentDescription("返回聊天列表");
            b.setOnClickListener(v -> { rememberDraft(); hideKeyboard(); showHome(); }); bar.addView(b, new LinearLayout.LayoutParams(dp(48), dp(48)));
        }
        LinearLayout text = column();
        TextView heading = label(title, back ? 20 : 28, INK); heading.setTypeface(null, Typeface.BOLD); heading.setId(R.id.chat_title);
        text.addView(heading); if (!subtitle.isEmpty()) text.addView(label(subtitle, 12, MUTED));
        bar.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1)); root.addView(bar);
        storageNotice = label(saveIssue, 12, WARN); storageNotice.setId(R.id.storage_notice); storageNotice.setPadding(dp(20), dp(4), dp(20), dp(8));
        storageNotice.setVisibility(saveIssue.isEmpty() ? View.GONE : View.VISIBLE); root.addView(storageNotice);
        return bar;
    }

    private void showHome() {
        rememberDraft(); page = "home"; shell();
        LinearLayout bar = toolbar("whisper", "留一点空间，好好聊聊", false);
        Button add = button("＋", R.id.new_chat, false); add.setTextSize(26); add.setContentDescription("新建聊天");
        add.setOnClickListener(v -> chooseNewChat()); bar.addView(add, new LinearLayout.LayoutParams(dp(48), dp(48)));
        Button settings = button("设置", R.id.settings, false); settings.setOnClickListener(v -> {
            if (generating) toast("请先停止回复，再调整连接设置。"); else showSettings();
        }); bar.addView(settings);
        TextView intro = label("聊天", 14, MUTED); intro.setPadding(dp(22), dp(18), dp(22), dp(8)); root.addView(intro);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout list = column(); list.setId(R.id.chat_list); list.setPadding(dp(12), 0, dp(12), dp(12));
        JSONArray chats = array(state, "chats");
        for (int i = 0; i < chats.length(); i++) {
            JSONObject c = chats.optJSONObject(i); if (c == null) continue;
            LinearLayout card = row(); card.setGravity(Gravity.CENTER_VERTICAL); card.setPadding(dp(14), dp(17), dp(14), dp(17));
            card.setBackground(shape(PAPER, 18));
            TextView avatar = avatar(c.optBoolean("group") ? "群" : c.optString("title", "聊"), c.optBoolean("group"));
            card.addView(avatar, new LinearLayout.LayoutParams(dp(50), dp(50)));
            LinearLayout info = column(); info.setPadding(dp(14), 0, 0, 0);
            TextView name = label(c.optString("title"), 17, INK); name.setTypeface(null, Typeface.BOLD); info.addView(name);
            JSONArray messages = array(c, "messages");
            String preview = "开始一段新的对话";
            if (messages.length() > 0) {
                JSONObject m = messages.optJSONObject(messages.length() - 1);
                preview = ("user".equals(m.optString("role")) ? "你" : m.optString("senderName")) + "：" + m.optString("content").replace('\n', ' ');
            }
            TextView summary = label(preview, 13, MUTED); summary.setMaxLines(1); summary.setEllipsize(android.text.TextUtils.TruncateAt.END); info.addView(summary);
            info.addView(label(chatMode(c) + (c.optBoolean("group") ? " · " + array(c, "members").length() + " 位成员" : " · 私聊"), 11, GREEN));
            card.addView(info, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            if (generating && activeChat == c) card.addView(label("回复中", 11, GREEN));
            else card.addView(label(new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(c.optLong("updatedAt"))), 11, MUTED));
            card.setOnClickListener(v -> showChat(c.optString("id")));
            card.setOnLongClickListener(v -> { confirmDeleteChat(c); return true; });
            LinearLayout.LayoutParams margin = fill(); margin.bottomMargin = dp(10); list.addView(card, margin);
        }
        if (chats.length() == 0) list.addView(note("还没有聊天。点右上角 ＋，创建私聊或群聊。"));
        scroll.addView(list); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView footer = note("原生 Android · 默认离线演示\n远程电脑与手机控制尚未接入"); root.addView(footer);
    }

    private void chooseNewChat() {
        if (generating) { toast("请先停止正在进行的回复。"); return; }
        if (array(state, "chats").length() >= 50) { toast("最多保留 50 个会话，可长按旧会话删除。"); return; }
        new AlertDialog.Builder(this).setTitle("新建聊天").setItems(new String[]{"新建私聊", "新建群聊"}, (dialog, which) -> {
            boolean group = which == 1;
            LinearLayout form = form();
            EditText name = input(group ? "群聊名称" : "聊天名称", R.id.new_chat_title, false); name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(40)}); form.addView(name);
            form.addView(note(group ? "先加入小苇和阿澄两位演示成员，创建后可分别设置厂商与模型。" : "先与演示成员小苇聊天，创建后可设置厂商与模型。"));
            new AlertDialog.Builder(this).setTitle(group ? "新建群聊" : "新建私聊").setView(form).setNegativeButton("取消", null)
                    .setPositiveButton("创建", (d, w) -> {
                        String title = name.getText().toString().trim(); if (title.isEmpty()) title = group ? "新的群聊" : "新的私聊";
                        JSONObject c = conversation(title, group); array(state, "chats").put(c); saveState(); showChat(c.optString("id"));
                    }).show();
        }).show();
    }

    private void confirmDeleteChat(JSONObject c) {
        if (generating && activeChat == c) { toast("请先停止这个会话的回复。"); return; }
        new AlertDialog.Builder(this).setTitle("删除「" + c.optString("title") + "」？").setMessage("删除这个设备上的会话和消息记录。凭据不会受影响。")
                .setNegativeButton("保留", null).setPositiveButton("删除", (d, w) -> {
                    removeObject(array(state, "chats"), c.optString("id")); saveState(); showHome();
                }).show();
    }

    private void showChat(String chatId) {
        rememberDraft(); JSONObject c = chat(chatId); if (c == null) { showHome(); return; }
        selectedChatId = chatId; put(state, "selectedChatId", chatId); page = "chat"; shell();
        LinearLayout bar = toolbar(c.optString("title"), chatMode(c) + (c.optBoolean("group") ? " · " + array(c, "members").length() + " 位成员依次回复" : " · 私聊"), true);
        Button members = button("成员", R.id.member_settings, false); members.setOnClickListener(v -> { if (generating) toast("请先停止回复，再调整成员。"); else showMembers(c); }); bar.addView(members);
        messageScroll = new ScrollView(this); messageScroll.setFillViewport(true); messageScroll.setClipToPadding(false); messageScroll.setPadding(dp(16), dp(8), dp(16), dp(12));
        messageList = column(); messageList.setId(R.id.messages); messageScroll.addView(messageList);
        JSONArray messages = array(c, "messages");
        if (messages.length() == 0) messageList.addView(note("聊点什么吧。\n" + (c.optBoolean("group") ? "每位成员会依次接力回复。" : "小小的想法，也值得慢慢说。")));
        for (int i = 0; i < messages.length(); i++) appendMessage(messages.optJSONObject(i));
        root.addView(messageScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        generationStatus = label(statusFor(c), 12, MUTED); generationStatus.setId(R.id.generation_status); generationStatus.setPadding(dp(18), dp(8), dp(18), dp(4)); generationStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(generationStatus);
        LinearLayout compose = row(); compose.setPadding(dp(12), dp(4), dp(12), dp(10)); compose.setGravity(Gravity.BOTTOM);
        composer = input("说点什么…", R.id.message_input, false); composer.setSingleLine(false); composer.setMaxLines(5); composer.setMinLines(1); composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setFilters(new InputFilter[]{new InputFilter.LengthFilter(8000)}); composer.setBackground(shape(PAPER, 18)); composer.setText(c.optString("draft"));
        compose.addView(composer, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout actions = column(); actions.setPadding(dp(8), 0, 0, 0);
        sendButton = button("发送", R.id.send_message, true); sendButton.setOnClickListener(v -> prepareSend(c)); actions.addView(sendButton);
        stopButton = button("停止", R.id.stop_generation, false); stopButton.setContentDescription("停止生成"); stopButton.setOnClickListener(v -> stopGeneration("已停止")); actions.addView(stopButton);
        compose.addView(actions); root.addView(compose); updateComposer(); scrollToBottom(true); saveState();
    }

    private void appendMessage(JSONObject m) {
        if (m == null || messageList == null) return;
        boolean mine = "user".equals(m.optString("role"));
        LinearLayout outer = column(); outer.setGravity(mine ? Gravity.END : Gravity.START);
        TextView name = label(mine ? "你" : m.optString("senderName") + ("demo".equals(m.optString("mode")) ? " · 演示" : " · API"), 11, MUTED);
        outer.addView(name);
        TextView content = label(m.optString("content").isEmpty() ? "…" : m.optString("content"), 16, INK); content.setTextIsSelectable(true); content.setLineSpacing(dp(3), 1.05f); content.setPadding(dp(15), dp(12), dp(15), dp(12)); content.setBackground(shape(mine ? LEAF : PAPER, 17));
        content.setMaxWidth(Math.max(dp(180), getResources().getDisplayMetrics().widthPixels - dp(74)));
        LinearLayout.LayoutParams bubble = new LinearLayout.LayoutParams(-2, -2); bubble.topMargin = dp(5); outer.addView(content, bubble);
        TextView status = label(messageStatus(m), 11, MUTED); status.setPadding(dp(2), dp(4), dp(2), 0); outer.addView(status); messageViews.put(m.optString("id"), content); messageStates.put(m.optString("id"), status);
        LinearLayout.LayoutParams margin = fill(); margin.bottomMargin = dp(17); messageList.addView(outer, margin);
    }

    private String messageStatus(JSONObject m) {
        switch (m.optString("status")) {
            case "streaming": return "正在回复…";
            case "stopped": return "已停止 · 保留已收到的内容";
            case "interrupted": return "回复已中断，可重新发送";
            case "error": return "回复失败 · 未自动重试";
            default: return "";
        }
    }

    private void prepareSend(JSONObject c) {
        if (generating || composer == null) return;
        String content = composer.getText().toString().trim(); if (content.isEmpty()) return;
        if (array(c, "messages").length() + array(c, "members").length() + 1 > MAX_MESSAGES) { toast("这个会话已达到 300 条消息上限，请新建会话。"); return; }
        List<String> destinations = new ArrayList<>();
        JSONArray members = array(c, "members");
        for (int i = 0; i < members.length(); i++) {
            JSONObject m = members.optJSONObject(i); if (DEMO.equals(m.optString("providerId"))) continue;
            if (updatingProviders.contains(m.optString("providerId"))) { toast("连接配置正在保存，请稍后发送。"); return; }
            JSONObject p = provider(m.optString("providerId"));
            if (p == null || credentials.get(m.optString("providerId")) == null) {
                new AlertDialog.Builder(this).setTitle("需要本次使用的凭据").setMessage("「" + m.optString("name") + "」尚未配置可用凭据。到设置输入凭据，或单独同意恢复此前加密保存的凭据。")
                        .setNegativeButton("取消", null).setPositiveButton("前往设置", (d, w) -> { rememberDraft(); showSettings(); }).show(); return;
            }
            destinations.add(m.optString("name") + " · " + p.optString("name") + "\n" + p.optString("endpoint") + "\n模型：" + m.optString("model"));
        }
        if (destinations.isEmpty()) beginSend(c, content);
        else new AlertDialog.Builder(this).setTitle("发送到实际 API？")
                .setMessage(String.join("\n\n", destinations) + "\n\n本次消息及当前聊天上下文将发送给以上厂商。群聊中前一位成员的回复也会发送给下一位。实际调用可能计费；停止不能撤回已发送的内容或已产生的费用。")
                .setNegativeButton("取消", null).setPositiveButton("确认发送", (d, w) -> beginSend(c, content)).show();
    }

    private void beginSend(JSONObject c, String content) {
        if (generating || destroyed) return;
        put(c, "draft", ""); if (composer != null) composer.setText("");
        JSONObject user = object("id", id(), "role", "user", "senderId", "self", "senderName", "你", "content", content, "status", "complete", "mode", "user", "createdAt", System.currentTimeMillis());
        array(c, "messages").put(user); put(c, "updatedAt", System.currentTimeMillis());
        generating = true; stopping = false; generation++; activeChat = c; activeMessage = null; activeMembers = array(c, "members"); memberIndex = 0; lastStatus = "";
        showChat(c.optString("id")); nextMember(generation);
    }

    private void nextMember(long expected) {
        if (!isCurrent(expected)) return;
        if (memberIndex >= activeMembers.length()) { finishGeneration("回复完成"); return; }
        JSONObject m = activeMembers.optJSONObject(memberIndex++);
        activeMessage = object("id", id(), "role", "assistant", "senderId", m.optString("id"), "senderName", m.optString("name"),
                "content", "", "status", "streaming", "mode", DEMO.equals(m.optString("providerId")) ? "demo" : "api", "createdAt", System.currentTimeMillis());
        array(activeChat, "messages").put(activeMessage); if (isActiveVisible()) appendMessage(activeMessage);
        updateComposer(); saveState(); scrollToBottom(true);
        if (DEMO.equals(m.optString("providerId"))) streamDemo(m, expected);
        else {
            JSONObject p = provider(m.optString("providerId")); String secret = credentials.get(m.optString("providerId"));
            if (p == null || secret == null) { failGeneration("这位成员的凭据不可用，请在设置中重新提供。"); return; }
            JSONArray context = contextFor(m);
            try {
                request = client.stream(p.optString("endpoint"), secret, m.optString("model"), context, new ChatClient.Listener() {
                    @Override public void onDelta(String text) { runOnUiThread(() -> { if (isCurrent(expected)) appendDelta(text); }); }
                    @Override public void onComplete() { runOnUiThread(() -> {
                        if (hasGeneration(expected)) { if (stopping) finishGeneration(stopReason); else completeMember(expected); }
                    }); }
                    @Override public void onError(String message) { runOnUiThread(() -> {
                        if (hasGeneration(expected)) { if (stopping) finishGeneration(stopReason); else failGeneration(message); }
                    }); }
                });
            } catch (RuntimeException unavailable) { failGeneration("暂时无法启动请求，请稍后重试。"); }
        }
    }

    private JSONArray contextFor(JSONObject member) {
        JSONArray context = new JSONArray();
        context.put(object("role", "system", "content", "You are " + member.optString("name") + ", a participant in this chat. Reply as yourself. Other participants are labeled by name. You have no computer or phone-control tools. Never claim that you performed an action outside this conversation."));
        JSONArray messages = array(activeChat, "messages");
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.optJSONObject(i);
            if (m == activeMessage || m.optString("content").isEmpty()) continue;
            if ("user".equals(m.optString("role"))) context.put(object("role", "user", "content", m.optString("content")));
            else if (member.optString("id").equals(m.optString("senderId"))) context.put(object("role", "assistant", "content", m.optString("content")));
            else context.put(object("role", "user", "content", "[" + m.optString("senderName") + "] " + m.optString("content")));
        }
        return context;
    }

    private void streamDemo(JSONObject member, long expected) {
        String prompt = ""; JSONArray messages = array(activeChat, "messages");
        for (int i = messages.length() - 1; i >= 0; i--) { JSONObject m = messages.optJSONObject(i); if ("user".equals(m.optString("role"))) { prompt = m.optString("content"); break; } }
        if (prompt.codePointCount(0, prompt.length()) > 60) prompt = prompt.substring(0, prompt.offsetByCodePoints(0, 60)) + "…";
        String response = "demo-spark".equals(member.optString("model"))
                ? "换个角度想一想「" + prompt + "」：\n\n可以先列出三个可能的方向，再挑最小的一步开始。如果是群聊，也可以给每位成员分配不同的观察角度。\n\n这是阿澄的离线演示回复，由设备本地文字模板生成，没有调用模型。"
                : "我收到了「" + prompt + "」。\n\n可以先说说你最想解决的一件事，再把想法拆成几个小步骤。我们可以从最容易开始的那一步聊起。\n\n这是小苇的离线演示回复，由设备本地文字模板生成，没有调用模型。";
        final int[] position = {0};
        demoTick = new Runnable() {
            @Override public void run() {
                if (!isCurrent(expected)) return;
                int count = Math.min(3, response.codePointCount(position[0], response.length()));
                int end = response.offsetByCodePoints(position[0], count); appendDelta(response.substring(position[0], end)); position[0] = end;
                if (end >= response.length()) completeMember(expected); else main.postDelayed(this, 35);
            }
        }; main.postDelayed(demoTick, 90);
    }

    private void appendDelta(String delta) {
        if (activeMessage == null || delta == null || delta.isEmpty()) return;
        String content = activeMessage.optString("content");
        if (content.length() + delta.length() > MAX_REPLY_CHARS) { stopGeneration("已停止：回复达到长度上限"); return; }
        put(activeMessage, "content", content + delta);
        TextView view = messageViews.get(activeMessage.optString("id")); if (view != null) view.setText(activeMessage.optString("content"));
        scrollToBottom(false);
        if (!saveScheduled) { saveScheduled = true; main.postDelayed(delayedSave, 750); }
    }

    private void completeMember(long expected) {
        if (!isCurrent(expected)) return;
        put(activeMessage, "status", "complete"); updateMessageState(); activeMessage = null; request = null; saveState();
        main.postDelayed(() -> nextMember(expected), 160);
    }

    private void failGeneration(String message) {
        if (activeMessage != null) {
            put(activeMessage, "status", "error");
            if (activeMessage.optString("content").isEmpty()) put(activeMessage, "content", message == null ? "请求失败，请检查连接设置。" : message);
            TextView view = messageViews.get(activeMessage.optString("id")); if (view != null) view.setText(activeMessage.optString("content")); updateMessageState();
        }
        finishGeneration("回复失败 · 可在设置检查连接");
    }

    private void stopGeneration(String reason) {
        if (!generating) return;
        if (stopping) return;
        if (demoTick != null) main.removeCallbacks(demoTick);
        if (activeMessage != null) { put(activeMessage, "status", "stopped"); updateMessageState(); }
        if (request != null) {
            stopping = true; stopReason = reason; request.cancel(); updateComposer(); saveState(); return;
        }
        generation++;
        finishGeneration(reason);
    }

    private void finishGeneration(String result) {
        generating = false; stopping = false; lastStatus = result; request = null; demoTick = null; activeMessage = null;
        if (activeChat != null) put(activeChat, "updatedAt", System.currentTimeMillis());
        updateComposer(); saveState(); if ("home".equals(page) && !destroyed) showHome();
    }

    private boolean hasGeneration(long expected) { return !destroyed && generating && generation == expected; }
    private boolean isCurrent(long expected) { return hasGeneration(expected) && !stopping; }
    private boolean isActiveVisible() { return "chat".equals(page) && activeChat != null && selectedChatId.equals(activeChat.optString("id")); }
    private void updateMessageState() { if (activeMessage != null) { TextView v = messageStates.get(activeMessage.optString("id")); if (v != null) v.setText(messageStatus(activeMessage)); } }
    private String statusFor(JSONObject c) {
        if (generating && stopping && activeChat == c) return "正在停止 · 等待网络请求结束";
        if (generating && activeChat == c) return "正在回复 · " + (activeMessage == null ? "准备中" : activeMessage.optString("senderName")) + " · " + chatMode(c);
        if (activeChat == c && !lastStatus.isEmpty()) return lastStatus;
        return chatMode(c) + " · 就绪";
    }
    private void updateComposer() {
        if (sendButton != null) sendButton.setEnabled(!generating);
        if (stopButton != null) { stopButton.setVisibility(generating ? View.VISIBLE : View.GONE); stopButton.setEnabled(generating && !stopping); }
        if (generationStatus != null) { JSONObject c = chat(selectedChatId); if (c != null) generationStatus.setText(statusFor(c)); }
    }

    private void showMembers(JSONObject c) {
        LinearLayout form = form(); TextView description = note("每位成员使用自己的厂商与模型。演示成员完全离线。群聊按以下顺序回复。"); form.addView(description);
        LinearLayout list = column(); list.setId(R.id.member_list); form.addView(list);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("聊天成员").setView(scroll(form)).setNegativeButton("完成", null).create();
        JSONArray members = array(c, "members");
        for (int i = 0; i < members.length(); i++) {
            JSONObject m = members.optJSONObject(i); Button edit = button(m.optString("name") + "\n" + providerName(m.optString("providerId")) + " · " + m.optString("model"), View.NO_ID, false); edit.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            edit.setOnClickListener(v -> { dialog.dismiss(); showMemberEditor(c, m); }); list.addView(edit, fill());
        }
        if (c.optBoolean("group")) {
            Button add = button("＋ 添加成员", R.id.add_member, true); add.setEnabled(members.length() < 6);
            add.setOnClickListener(v -> { dialog.dismiss(); showMemberEditor(c, null); }); form.addView(add);
            form.addView(note("群聊支持 2–6 位成员。点击已有成员可编辑或移除。"));
        }
        dialog.show();
    }

    private void showMemberEditor(JSONObject c, JSONObject existing) {
        LinearLayout form = form();
        EditText name = input("成员昵称", R.id.member_name, false); name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(30)}); name.setText(existing == null ? "新成员" : existing.optString("name")); form.addView(label("昵称", 12, MUTED)); form.addView(name);
        List<String> providerIds = new ArrayList<>(); List<String> providerNames = new ArrayList<>(); providerIds.add(DEMO); providerNames.add("离线演示（无需联网）");
        JSONArray providers = array(state, "providers");
        for (int i = 0; i < providers.length(); i++) { JSONObject p = providers.optJSONObject(i); providerIds.add(p.optString("id")); providerNames.add(p.optString("name")); }
        Spinner providerChoice = new Spinner(this); providerChoice.setId(R.id.member_provider); providerChoice.setContentDescription("成员厂商");
        providerChoice.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, providerNames)); form.addView(label("厂商", 12, MUTED)); form.addView(providerChoice, fill());
        AutoCompleteTextView model = new AutoCompleteTextView(this); model.setId(R.id.member_model); styleInput(model); model.setHint("模型名称"); model.setSingleLine(true); model.setThreshold(0); model.setFilters(new InputFilter[]{new InputFilter.LengthFilter(128)});
        form.addView(label("模型（点按选择，也可手动输入）", 12, MUTED)); form.addView(model, fill()); model.setOnClickListener(v -> model.showDropDown());
        final boolean[] initial = {true};
        providerChoice.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long value) {
                String pid = providerIds.get(position); JSONArray choices = DEMO.equals(pid) ? new JSONArray().put("demo-gentle").put("demo-spark") : array(provider(pid), "models");
                List<String> models = new ArrayList<>(); for (int i = 0; i < choices.length(); i++) models.add(choices.optString(i));
                model.setAdapter(new ArrayAdapter<>(MainActivity.this, android.R.layout.simple_dropdown_item_1line, models));
                if (initial[0] && existing != null && pid.equals(existing.optString("providerId"))) model.setText(existing.optString("model"), false);
                else model.setText(models.isEmpty() ? "" : models.get(0), false);
                initial[0] = false;
            }
            @Override public void onNothingSelected(AdapterView<?> parent) { }
        });
        if (existing != null) { int selected = providerIds.indexOf(existing.optString("providerId")); providerChoice.setSelection(Math.max(0, selected)); }
        form.addView(note("真实 API 需要先在设置提供凭据。Android 的 ChatGPT 登录尚未接入；此处不接受 OpenAI API 密钥作为替代。"));
        AlertDialog.Builder builder = new AlertDialog.Builder(this).setTitle(existing == null ? "添加成员" : "编辑成员").setView(scroll(form)).setNegativeButton("取消", (d, w) -> showMembers(c)).setPositiveButton("保存", null);
        if (existing != null && c.optBoolean("group") && array(c, "members").length() > 2) builder.setNeutralButton("移除", (d, w) -> { removeObject(array(c, "members"), existing.optString("id")); saveState(); showChat(c.optString("id")); showMembers(c); });
        AlertDialog dialog = builder.create(); dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String title = name.getText().toString().trim(); String selectedModel = model.getText().toString().trim(); String pid = providerIds.get(providerChoice.getSelectedItemPosition());
            if (title.isEmpty()) { name.setError("请填写昵称"); return; }
            if (!validModel(selectedModel)) { model.setError("请填写有效的模型名称（不能含空白）"); return; }
            if (DEMO.equals(pid) && !selectedModel.equals("demo-gentle") && !selectedModel.equals("demo-spark")) { model.setError("演示模型请选择 demo-gentle 或 demo-spark"); return; }
            JSONObject m = existing == null ? member(title, selectedModel) : existing; put(m, "name", title); put(m, "providerId", pid); put(m, "model", selectedModel); if (existing == null) array(c, "members").put(m);
            saveState(); dialog.dismiss(); showChat(c.optString("id")); showMembers(c);
        })); dialog.show();
    }

    private void showSettings() {
        rememberDraft(); hideKeyboard(); page = "settings"; shell(); toolbar("设置", "连接由你决定，凭据由你保管", true);
        LinearLayout form = form();
        form.addView(section("模型连接"));
        form.addView(note("离线演示始终可用，不会联网，也不会产生模型费用。添加连接不会自动发起真实调用。"));
        Button add = button("＋ 添加兼容厂商", R.id.provider_add, true); add.setOnClickListener(v -> { if (array(state, "providers").length() >= 20) toast("最多添加 20 个厂商连接。"); else showProviderEditor(null); }); form.addView(add, fill());
        JSONArray providers = array(state, "providers");
        for (int i = 0; i < providers.length(); i++) {
            JSONObject p = providers.optJSONObject(i); LinearLayout card = form(); card.setBackground(shape(PAPER, 16));
            card.addView(section(p.optString("name"))); card.addView(label(p.optString("endpoint"), 12, MUTED)); card.addView(label("模型：" + join(array(p, "models")), 12, MUTED));
            String credentialState = credentials.get(p.optString("id")) != null ? "本次凭据已就绪" : (credentials.hasPersisted(p.optString("id")) ? "有加密保存的凭据，尚未恢复" : "尚未提供凭据");
            card.addView(label(credentialState, 12, GREEN)); LinearLayout actions = row();
            Button edit = button("编辑连接", View.NO_ID, false); edit.setOnClickListener(v -> showProviderEditor(p)); actions.addView(edit);
            Button key = button("凭据", View.NO_ID, false); key.setContentDescription(p.optString("name") + " 凭据"); key.setOnClickListener(v -> showCredentialDialog(p)); actions.addView(key); card.addView(actions);
            LinearLayout.LayoutParams margin = fill(); margin.topMargin = dp(14); form.addView(card, margin);
        }
        form.addView(section("ChatGPT")); form.addView(note("Android 官方登录尚未接入。这里不会使用 OpenAI API 密钥、已有 Codex 登录或桌面会话来替代授权。"));
        form.addView(section("设备与隐私")); form.addView(note("聊天记录保留在本机。手动凭据默认只在本次应用进程的内存中；只有单独勾选才会加密保存，重启后还需要单独同意恢复。\n\n本应用只申请网络权限，不申请无障碍、悬浮窗或文件管理权限。远程电脑、手机控制和跨设备同步尚未接入。"));
        form.addView(note("whisper 0.2.0 · 原生 Android")); root.addView(scroll(form), new LinearLayout.LayoutParams(-1, 0, 1));
    }

    private void showProviderEditor(JSONObject existing) {
        if (!storageAvailable) { toast("本机记录暂时不可用，无法保存新连接。"); return; }
        LinearLayout form = form();
        form.addView(note("仅用于其他厂商的 OpenAI-compatible HTTPS 接口。实际调用可能计费，聊天上下文会发送给该厂商。OpenAI/ChatGPT 官方域名和 API 密钥替代路径不受支持。"));
        EditText name = input("厂商名称，例如我的模型服务", R.id.provider_name, false); name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(60)});
        EditText endpoint = input("https://api.example.com/v1", R.id.provider_endpoint, false); endpoint.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText models = input("模型名称，多个名称用逗号分隔", R.id.provider_models, false);
        if (existing != null) {
            name.setText(existing.optString("name")); endpoint.setText(existing.optString("endpoint")); models.setText(join(array(existing, "models")));
            endpoint.setEnabled(false);
            form.addView(note("已有连接的接口地址固定。更换厂商地址请添加新连接，避免把旧凭据交给新地址。"));
        }
        form.addView(label("显示名称", 12, MUTED)); form.addView(name); form.addView(label("HTTPS 接口（不支持内网/localhost）", 12, MUTED)); form.addView(endpoint); form.addView(label("模型", 12, MUTED)); form.addView(models);
        EditText secret = input(existing == null ? "本次使用的 API 凭据（可稍后填写）" : "新凭据（留空保留现有凭据）", R.id.provider_secret, true); form.addView(secret);
        CheckBox persist = consentCheckbox(); form.addView(persist);
        form.addView(note("未勾选时仅放在内存中，退出应用进程后需重新提供。只保存连接配置不会调用 API。"));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(existing == null ? "添加兼容厂商" : "编辑连接").setView(scroll(form)).setNegativeButton("取消", null).setPositiveButton("保存连接", null).create();
        dialog.setOnShowListener(d -> { secure(dialog); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String title = name.getText().toString().trim(); String address;
            if (title.isEmpty()) { name.setError("请填写厂商名称"); return; }
            try { address = ChatClient.validateEndpoint(endpoint.getText().toString().trim()); }
            catch (RuntimeException invalid) { endpoint.setError("请填写其他厂商的公网 HTTPS 接口，不含账号、参数、内网地址或 OpenAI 域名"); return; }
            JSONArray selectedModels = parseModels(models.getText().toString()); if (selectedModels.length() == 0 || selectedModels.length() > 20) { models.setError("请填写 1–20 个有效模型名称"); return; }
            String value = secret.getText().toString(); if (!value.isEmpty() && !validCredential(value)) { secret.setError("凭据不应包含空白，且不能超过 8192 字符"); return; }
            if (value.isEmpty() && persist.isChecked()) { secret.setError("请输入要加密保存的凭据，或取消勾选"); return; }
            JSONObject p = object("id", existing == null ? id() : existing.optString("id"), "name", title, "endpoint", address, "models", selectedModels);
            boolean saveSecret = persist.isChecked(); secret.setText(""); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            // Commit metadata before activating credentials. This transaction
            // survives Activity recreation and never creates an orphan secret.
            if (existing == null) array(state, "providers").put(p);
            else { put(existing, "name", title); put(existing, "endpoint", address); put(existing, "models", selectedModels); }
            final String snapshot = state.toString();
            updatingProviders.add(p.optString("id"));
            disk.execute(() -> {
                boolean success = true;
                try {
                    localStore.save(new JSONObject(snapshot));
                    if (!value.isEmpty()) credentials.put(p.optString("id"), value, saveSecret);
                } catch (Exception failure) { success = false; }
                finally { updatingProviders.remove(p.optString("id")); }
                final boolean stored = success;
                runOnUiThread(() -> {
                    if (destroyed) return;
                    saveIssue = stored ? "" : "连接或凭据保存未完成。请释放空间或删除旧会话后重试；未提交新的凭据。";
                    dialog.dismiss(); showSettings();
                    toast(stored ? "连接已保存，尚未调用 API。" : saveIssue);
                });
            });
        }); }); dialog.show();
    }

    private void showCredentialDialog(JSONObject p) {
        if (updatingProviders.contains(p.optString("id"))) { toast("连接正在保存，请稍后操作凭据。"); return; }
        LinearLayout form = form(); form.addView(note(p.optString("name") + "\n" + p.optString("endpoint") + "\n\n实际调用可能计费。凭据不会写入聊天记录。"));
        EditText secret = input("粘贴本次使用的 API 凭据", R.id.provider_secret, true); form.addView(secret);
        CheckBox persist = consentCheckbox(); form.addView(persist);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("凭据").setView(scroll(form)).setNegativeButton("取消", null).setPositiveButton("使用凭据", null).create();
        if (credentials.hasPersisted(p.optString("id"))) {
            Button restore = button("恢复已保存凭据…", R.id.restore_credential, false); restore.setOnClickListener(v -> { dialog.dismiss(); confirmRestore(p); }); form.addView(restore);
        }
        if (credentials.hasPersisted(p.optString("id")) || credentials.get(p.optString("id")) != null) {
            Button remove = button("清除本次及已保存凭据", View.NO_ID, false); remove.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("清除凭据？").setMessage("将清除这个连接在内存和设备加密存储中的凭据，聊天记录会保留。")
                    .setNegativeButton("保留", null).setPositiveButton("清除", (d, w) -> credentialAction(() -> credentials.remove(p.optString("id")), () -> { dialog.dismiss(); showSettings(); toast("凭据已清除。"); })).show()); form.addView(remove);
        }
        dialog.setOnShowListener(d -> { secure(dialog); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String value = secret.getText().toString(); if (!validCredential(value)) { secret.setError("请输入有效凭据（不能含空白，最多 8192 字符）"); return; }
            boolean save = persist.isChecked(); secret.setText(""); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            final String snapshot = state.toString();
            updatingProviders.add(p.optString("id"));
            credentialAction(() -> {
                try {
                    // Even a provider retained in memory after an earlier save
                    // failure must be durable before its credential can persist.
                    localStore.save(new JSONObject(snapshot));
                    credentials.put(p.optString("id"), value, save);
                } finally { updatingProviders.remove(p.optString("id")); }
            }, () -> { dialog.dismiss(); showSettings(); toast(save ? "已加密保存，当前进程可用。" : "凭据仅在当前进程内存中使用。"); }, () -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true));
        }); }); dialog.show();
    }

    private void confirmRestore(JSONObject p) {
        new AlertDialog.Builder(this).setTitle("允许本次恢复凭据？").setMessage("把「" + p.optString("name") + "」此前加密保存在本设备的凭据恢复到本次进程的内存。此操作不会发起模型调用。")
                .setNegativeButton("暂不恢复", null).setPositiveButton("允许本次恢复", (d, w) -> credentialAction(() -> {
                    if (credentials.restore(p.optString("id"), true) == null) throw new IllegalStateException("Unavailable");
                }, () -> { showSettings(); toast("凭据已恢复到本次内存。"); })).show();
    }

    private interface CredentialAction { void run() throws Exception; }
    private void credentialAction(CredentialAction action, Runnable onSuccess) { credentialAction(action, onSuccess, () -> { }); }
    private void credentialAction(CredentialAction action, Runnable onSuccess, Runnable onFailure) {
        disk.execute(() -> { boolean success = true; try { action.run(); } catch (Exception error) { success = false; } final boolean done = success;
            runOnUiThread(() -> { if (destroyed) return; if (done) onSuccess.run(); else { onFailure.run(); toast("凭据操作未完成，请重新输入或稍后重试。"); } }); });
    }

    private CheckBox consentCheckbox() {
        CheckBox check = new CheckBox(this); check.setId(R.id.save_credential); check.setText("将凭据加密保存在本机（可选）"); check.setTextColor(INK); check.setTextSize(13); check.setChecked(false); check.setSaveEnabled(false); check.setMinHeight(dp(48)); return check;
    }
    private void secure(AlertDialog dialog) { if (dialog.getWindow() != null) dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE); }

    private JSONArray parseModels(String value) {
        JSONArray models = new JSONArray(); List<String> seen = new ArrayList<>();
        for (String s : value.split("[,，\\n]")) { String m = s.trim(); if (m.isEmpty()) continue; if (!validModel(m)) return new JSONArray(); if (!seen.contains(m)) { seen.add(m); models.put(m); } }
        return models;
    }
    private boolean validModel(String value) { return value.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}"); }
    private boolean validCredential(String value) { return !value.isEmpty() && value.length() <= 8192 && !value.matches("(?s).*\\s.*") && !value.chars().anyMatch(Character::isISOControl); }
    private String chatMode(JSONObject c) { for (int i = 0; i < array(c, "members").length(); i++) if (!DEMO.equals(array(c, "members").optJSONObject(i).optString("providerId"))) return "含实际 API · 可能计费"; return "离线演示"; }
    private String providerName(String providerId) { if (DEMO.equals(providerId)) return "离线演示"; JSONObject p = provider(providerId); return p == null ? "未配置厂商" : p.optString("name"); }
    private JSONObject chat(String chatId) { return find(array(state, "chats"), chatId); }
    private JSONObject provider(String providerId) { return find(array(state, "providers"), providerId); }
    private JSONObject find(JSONArray items, String identity) { for (int i = 0; i < items.length(); i++) { JSONObject item = items.optJSONObject(i); if (item != null && item.optString("id").equals(identity)) return item; } return null; }
    private void removeObject(JSONArray items, String identity) { for (int i = 0; i < items.length(); i++) if (items.optJSONObject(i).optString("id").equals(identity)) { items.remove(i); return; } }
    private void rememberDraft() { if (composer != null && state != null && "chat".equals(page)) { JSONObject c = chat(selectedChatId); if (c != null) put(c, "draft", composer.getText().toString()); } }

    private void saveState() {
        main.removeCallbacks(delayedSave); saveScheduled = false;
        if (state == null || !storageAvailable || disk.isShutdown()) return;
        rememberDraft(); final String snapshot = state.toString();
        disk.execute(() -> { boolean success = true; try { localStore.save(new JSONObject(snapshot)); } catch (Exception error) { success = false; }
            final boolean saved = success;
            runOnUiThread(() -> { if (destroyed) return; saveIssue = saved ? "" : "本次记录未能保存。请释放空间或在列表长按删除旧会话；重启可能丢失未保存内容。";
                if (storageNotice != null) { storageNotice.setText(saveIssue); storageNotice.setVisibility(saveIssue.isEmpty() ? View.GONE : View.VISIBLE); } });
        });
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        rememberDraft(); out.putString("page", page); out.putString("chat", selectedChatId); saveState(); super.onSaveInstanceState(out);
    }
    @Override protected void onStop() { rememberDraft(); saveState(); super.onStop(); }
    @Override protected void onDestroy() {
        if (generating) stopGeneration("已停止"); saveState(); destroyed = true; main.removeCallbacksAndMessages(null); client.close(); super.onDestroy();
    }
    private void navigateBack() { if (!"home".equals(page)) { rememberDraft(); hideKeyboard(); showHome(); saveState(); } else finish(); }
    // API 33+ uses the native OnBackInvokedDispatcher registered in onCreate.
    // Keep this method only for API 26-32; modern gestures do not depend on it.
    @SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { navigateBack(); }

    private void scrollToBottom(boolean force) {
        if (messageScroll == null) return;
        ScrollView current = messageScroll; boolean nearBottom = current.getChildCount() == 0 || current.getChildAt(0).getHeight() - current.getHeight() - current.getScrollY() < dp(150);
        if (force || nearBottom) current.post(() -> current.fullScroll(View.FOCUS_DOWN));
    }
    private void hideKeyboard() { View focus = getCurrentFocus(); if (focus != null) ((InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(focus.getWindowToken(), 0); }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); return view; }
    private LinearLayout form() { LinearLayout view = column(); view.setPadding(dp(20), dp(12), dp(20), dp(12)); return view; }
    private ScrollView scroll(View child) { ScrollView view = new ScrollView(this); view.setFillViewport(false); view.addView(child); return view; }
    private LinearLayout.LayoutParams fill() { return new LinearLayout.LayoutParams(-1, -2); }
    private GradientDrawable shape(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape; }
    private TextView label(String text, float size, int color) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); return view; }
    private TextView note(String text) { TextView view = label(text, 13, MUTED); view.setLineSpacing(dp(4), 1f); view.setPadding(dp(8), dp(12), dp(8), dp(14)); return view; }
    private TextView section(String text) { TextView view = label(text, 17, INK); view.setTypeface(null, Typeface.BOLD); view.setPadding(0, dp(22), 0, dp(9)); return view; }
    private TextView avatar(String title, boolean group) { TextView view = label(title.isEmpty() ? "聊" : title.substring(0, title.offsetByCodePoints(0, 1)), 22, GREEN); view.setGravity(Gravity.CENTER); view.setBackground(shape(group ? Color.rgb(233, 229, 198) : LEAF, 16)); return view; }
    private Button button(String title, int identity, boolean primary) { Button view = new Button(this); if (identity != View.NO_ID) view.setId(identity); view.setText(title); view.setTextSize(14); view.setAllCaps(false); view.setMinHeight(dp(48)); view.setMinimumHeight(dp(48)); view.setMinWidth(dp(48)); view.setMinimumWidth(dp(48)); view.setPadding(dp(14), dp(8), dp(14), dp(8)); view.setTextColor(primary ? Color.WHITE : GREEN); view.setBackground(shape(primary ? GREEN : Color.TRANSPARENT, 14)); return view; }
    private EditText input(String hint, int identity, boolean secret) {
        EditText view = new EditText(this); view.setId(identity); styleInput(view); view.setHint(hint); view.setSingleLine(true);
        view.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        if (secret) { view.setSaveEnabled(false); view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); view.setFilters(new InputFilter[]{new InputFilter.LengthFilter(8192)}); }
        return view;
    }
    private void styleInput(EditText view) { view.setTextColor(INK); view.setHintTextColor(MUTED); view.setTextSize(15); view.setMinHeight(dp(50)); view.setPadding(dp(12), dp(12), dp(12), dp(12)); view.setBackground(shape(PAPER, 12)); }
    private static String id() { return UUID.randomUUID().toString(); }
    private static JSONArray array(JSONObject object, String key) { if (object == null) return new JSONArray(); JSONArray value = object.optJSONArray(key); return value == null ? new JSONArray() : value; }
    private static JSONObject object(Object... pairs) { JSONObject value = new JSONObject(); for (int i = 0; i < pairs.length; i += 2) put(value, (String) pairs[i], pairs[i + 1]); return value; }
    private static void put(JSONObject object, String key, Object value) { try { object.put(key, value); } catch (JSONException invalid) { throw new IllegalArgumentException("Invalid local state"); } }
    private static String join(JSONArray values) { List<String> list = new ArrayList<>(); for (int i = 0; i < values.length(); i++) list.add(values.optString(i)); return String.join(", ", list); }
}
