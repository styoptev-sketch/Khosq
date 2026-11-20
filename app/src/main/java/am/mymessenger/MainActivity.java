package am.mymessenger;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.view.Gravity;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The window. The WebView itself belongs to Hub, so closing this window
 * does not stop the messenger. This activity only attaches the WebView to the screen.
 */
public class MainActivity extends Activity {

    private static final int REQ_MEDIA = 1;
    private static final int REQ_BASIC = 2;
    private static final int REQ_FILE = 3;
    private static final int REQ_AUTH = 4;
    private static final long LOCK_GRACE_MS = 30000;

    private ValueCallback<Uri[]> fileCallback;
    private View lockView;
    private boolean unlocked = false;
    private boolean authing = false;
    private boolean overLockCall = false;
    private long leftAt = 0;

    private PermissionRequest pendingRequest;
    private FrameLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Hub.activity = this;

        root = new FrameLayout(this);
        setContentView(root);

        // If the last run crashed, show the error first and continue only after OK.
        if (!showLastCrash(new Runnable() {
            @Override
            public void run() {
                continueStart();
            }
        })) {
            continueStart();
        }
    }

    private void continueStart() {
        attachWeb();
        startService();
        askBasicPermissions();
        handleIntent(getIntent());
    }

    private void attachWeb() {
        WebView w = Hub.ensure(this);
        if (w.getParent() instanceof ViewGroup) {
            ((ViewGroup) w.getParent()).removeView(w);
        }
        root.addView(w, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (lockView != null && lockView.getParent() != null) {
            lockView.bringToFront();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** Opened from a notification: show the chat, and show over the lock screen for calls. */
    /** If the app crashed last time, show the error text so it can be reported. */
    private boolean showLastCrash(final Runnable after) {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "crash.txt");
            if (!f.exists()) return false;
            byte[] b = new byte[(int) Math.min(f.length(), 6000)];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int n = in.read(b);
            in.close();
            f.delete();
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText(new String(b, 0, Math.max(n, 0), "UTF-8"));
            tv.setTextSize(11);
            tv.setTextIsSelectable(true);
            tv.setPadding(24, 24, 24, 24);
            android.widget.ScrollView sv = new android.widget.ScrollView(this);
            sv.addView(tv);
            new android.app.AlertDialog.Builder(this)
                    .setTitle("Նախորդ անգամ սխալ եղավ. արեք սքրինշոթ")
                    .setView(sv)
                    .setPositiveButton("OK", null)
                    .setOnDismissListener(new android.content.DialogInterface.OnDismissListener() {
                        @Override
                        public void onDismiss(android.content.DialogInterface d) {
                            after.run();
                        }
                    })
                    .show();
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void startService() {
        try {
            startForegroundService(new Intent(this, MessengerService.class));
        } catch (Exception e) {
            // The app still works while it is open.
        }
    }

    /** Opened from a notification: show the chat, and show over the lock screen for calls. */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if ("call".equals(intent.getAction())) {
            showOverLock(true);
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            overLockCall = km != null && km.isKeyguardLocked();
        }
        String chat = intent.getStringExtra("chat");
        if (chat != null && !chat.isEmpty()) {
            Hub.pendingChat = chat;
            Hub.ensure(this).evaluateJavascript(
                    "window.__open && window.__open(" + JSONObject.quote(chat) + ")",
                    value -> { if ("true".equals(value)) Hub.pendingChat = null; });
        }
        intent.removeExtra("chat");
        intent.setAction(null);
    }

    @SuppressWarnings("deprecation")
    private void showOverLock(boolean on) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else {
            int f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (on) {
                getWindow().addFlags(f);
            } else {
                getWindow().clearFlags(f);
            }
        }
    }

    /* ---------- permissions ---------- */

    private void askBasicPermissions() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.CAMERA);
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (need.isEmpty()) {
            askBatteryOnce();
        } else {
            requestPermissions(need.toArray(new String[0]), REQ_BASIC);
        }
    }

    private void askBatteryOnce() {
        SharedPreferences sp = getSharedPreferences("app", MODE_PRIVATE);
        if (sp.getBoolean("battery_asked", false)) return;
        sp.edit().putBoolean("battery_asked", true).apply();
        new NativeBridge(getApplicationContext()).openSettings("battery");
    }

    /** Called when the page asks for camera or microphone. */
    void handlePermissionRequest(PermissionRequest request) {
        List<String> missing = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.CAMERA);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.RECORD_AUDIO);
            }
        }
        if (missing.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        if (pendingRequest != null) {
            pendingRequest.deny();
        }
        pendingRequest = request;
        requestPermissions(missing.toArray(new String[0]), REQ_MEDIA);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BASIC) {
            askBatteryOnce();
            return;
        }
        if (requestCode != REQ_MEDIA || pendingRequest == null) {
            return;
        }
        boolean all = grantResults.length > 0;
        for (int g : grantResults) {
            if (g != PackageManager.PERMISSION_GRANTED) {
                all = false;
            }
        }
        if (all) {
            pendingRequest.grant(pendingRequest.getResources());
        } else {
            pendingRequest.deny();
        }
        pendingRequest = null;
    }

    /* ---------- lifecycle ---------- */

    @Override
    protected void onStart() {
        super.onStart();
        Hub.visible = true;
        checkLock();
    }

    @Override
    protected void onResume() {
        super.onResume();
        askFullScreenOnce();
    }

    @Override
    protected void onStop() {
        Hub.visible = false;
        leftAt = System.currentTimeMillis();
        overLockCall = false;
        showOverLock(false);
        super.onStop();
    }

    /* ---------- full-screen call permission (Android 14+) ---------- */

    private void askFullScreenOnce() {
        if (Build.VERSION.SDK_INT < 34) return;
        SharedPreferences sp = getSharedPreferences("app", MODE_PRIVATE);
        if (!sp.getBoolean("battery_asked", false) || sp.getBoolean("fsi_asked", false)) return;
        sp.edit().putBoolean("fsi_asked", true).apply();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null && !nm.canUseFullScreenIntent()) {
            new NativeBridge(getApplicationContext()).openSettings("fullscreen");
        }
    }

    /* ---------- call opened over the lock screen ---------- */

    /** The call is over: if the phone is still locked, do not leave the chats visible over the lock screen. */
    void onCallFinished() {
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (overLockCall && km != null && km.isKeyguardLocked()) {
            moveTaskToBack(true);
        }
        overLockCall = false;
    }

    /* ---------- app lock ---------- */

    private boolean lockOn() {
        return getSharedPreferences("app", MODE_PRIVATE).getBoolean("lock", false);
    }

    private void applySecureFlag() {
        if (lockOn()) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    private void checkLock() {
        applySecureFlag();
        if (!lockOn()) {
            hideLock();
            return;
        }
        if (overLockCall) return; // only the call screen is shown while the phone is locked
        if (unlocked && System.currentTimeMillis() - leftAt < LOCK_GRACE_MS) return;
        unlocked = false;
        showLock();
        requestAuth();
    }

    /** Called by the page when the lock is switched on or off. */
    void onLockChanged() {
        applySecureFlag();
        if (lockOn()) {
            unlocked = true; // the person is inside the app right now
            leftAt = System.currentTimeMillis();
        } else {
            hideLock();
        }
    }

    private void showLock() {
        if (root == null) return;
        if (lockView == null) {
            FrameLayout f = new FrameLayout(this);
            f.setBackgroundColor(0xFF0B1230);
            f.setClickable(true);
            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setGravity(Gravity.CENTER);
            TextView t = new TextView(this);
            t.setText("Կողպված է");
            t.setTextColor(0xFFF4F6FD);
            t.setTextSize(26);
            t.setGravity(Gravity.CENTER);
            Button b = new Button(this);
            b.setText("Բացել");
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    requestAuth();
                }
            });
            col.addView(t);
            col.addView(b);
            f.addView(col, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            lockView = f;
        }
        if (lockView.getParent() == null) {
            root.addView(lockView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        lockView.bringToFront();
    }

    private void hideLock() {
        if (lockView != null && lockView.getParent() instanceof ViewGroup) {
            ((ViewGroup) lockView.getParent()).removeView(lockView);
        }
    }

    private void requestAuth() {
        if (authing) return;
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        Intent i = km == null ? null
                : km.createConfirmDeviceCredentialIntent("KHOSQ", "Հաստատիր, որ դու ես");
        if (i == null) {
            // The phone has no screen lock any more, so there is nothing to ask.
            getSharedPreferences("app", MODE_PRIVATE).edit().putBoolean("lock", false).apply();
            unlocked = true;
            hideLock();
            applySecureFlag();
            return;
        }
        authing = true;
        try {
            startActivityForResult(i, REQ_AUTH);
        } catch (Exception e) {
            authing = false;
        }
    }

    /* ---------- photo picker for the page ---------- */

    boolean pickFile(ValueCallback<Uri[]> callback) {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
        }
        fileCallback = callback;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("image/*");
        i.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(i, "Ընտրիր լուսանկար"), REQ_FILE);
        } catch (Exception e) {
            fileCallback = null;
            callback.onReceiveValue(null);
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
        } else if (requestCode == REQ_AUTH) {
            authing = false;
            if (resultCode == RESULT_OK) {
                unlocked = true;
                leftAt = System.currentTimeMillis();
                hideLock();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (lockView != null && lockView.getParent() != null) {
            moveTaskToBack(true);
            return;
        }
        Hub.ensure(this).evaluateJavascript(
                "window.__back ? window.__back() : false", value -> {
                    if (!"true".equals(value)) {
                        // Hide the window but keep the messenger running.
                        moveTaskToBack(true);
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (pendingRequest != null) {
            pendingRequest.deny();
            pendingRequest = null;
        }
        if (root != null) {
            root.removeAllViews(); // the WebView stays alive in Hub
        }
        if (Hub.activity == this) {
            Hub.activity = null;
        }
        super.onDestroy();
    }
}
