package am.mymessenger;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

/** Functions the messenger page can call: notifications, the ringtone, system settings and sharing. */
public class NativeBridge {

    static final String CH_SERVICE = "service";
    static final String CH_MSG = "messages";
    static final String CH_CALL = "calls";
    static final int NOTE_SERVICE = 1;
    static final int NOTE_CALL = 2;

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaPlayer player;

    private final Runnable ringStop = new Runnable() {
        @Override
        public void run() {
            stopRingNow();
        }
    };

    public NativeBridge(Context context) {
        this.ctx = context.getApplicationContext();
    }

    static void createChannels(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Աշխատանք ֆոնում", NotificationManager.IMPORTANCE_LOW);
        svc.setShowBadge(false);

        NotificationChannel msg = new NotificationChannel(CH_MSG, "Նամակներ", NotificationManager.IMPORTANCE_HIGH);

        NotificationChannel call = new NotificationChannel(CH_CALL, "Զանգեր", NotificationManager.IMPORTANCE_HIGH);
        call.setSound(null, null);
        call.enableVibration(false);
        call.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        nm.createNotificationChannel(svc);
        nm.createNotificationChannel(msg);
        nm.createNotificationChannel(call);
    }

    private NotificationManager nm() {
        return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private PendingIntent openIntent(String action, String chatId, int requestCode) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction(action);
        i.putExtra("chat", chatId);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* ---------- messages ---------- */

    @JavascriptInterface
    public void notifyMessage(String chatId, String name, String text) {
        if (Hub.visible || chatId == null || chatId.isEmpty()) {
            return;
        }
        NotificationManager nm = nm();
        if (nm == null) {
            return;
        }
        Notification n = new Notification.Builder(ctx, CH_MSG)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(name)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(openIntent("open", chatId, chatId.hashCode()))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .build();
        nm.notify(chatId.hashCode(), n);
    }

    @JavascriptInterface
    public void clearNotification(String chatId) {
        NotificationManager nm = nm();
        if (nm != null && chatId != null) {
            nm.cancel(chatId.hashCode());
        }
    }

    @JavascriptInterface
    public String consumePendingChat() {
        String c = Hub.pendingChat;
        Hub.pendingChat = null;
        return c == null ? "" : c;
    }

    /* ---------- calls ---------- */

    @JavascriptInterface
    public void incomingCall(final String chatId, final String name, final boolean video) {
        main.post(new Runnable() {
            @Override
            public void run() {
                startRingNow();
                if (Hub.visible) {
                    return;
                }
                NotificationManager nm = nm();
                if (nm == null) {
                    return;
                }
                PendingIntent pi = openIntent("call", chatId, 7001);
                Notification n = new Notification.Builder(ctx, CH_CALL)
                        .setSmallIcon(R.drawable.ic_stat)
                        .setContentTitle(name)
                        .setContentText(video ? "Տեսազանգ" : "Ձայնային զանգ")
                        .setCategory(Notification.CATEGORY_CALL)
                        .setOngoing(true)
                        .setAutoCancel(false)
                        .setContentIntent(pi)
                        .setFullScreenIntent(pi, true)
                        .build();
                nm.notify(NOTE_CALL, n);
            }
        });
    }

    @JavascriptInterface
    public void stopCall() {
        main.post(new Runnable() {
            @Override
            public void run() {
                stopRingNow();
                NotificationManager nm = nm();
                if (nm != null) {
                    nm.cancel(NOTE_CALL);
                }
            }
        });
    }

    private void startRingNow() {
        stopRingNow();
        try {
            MediaPlayer p = new MediaPlayer();
            p.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            AssetFileDescriptor afd = ctx.getResources().openRawResourceFd(R.raw.ringtone);
            p.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            p.setLooping(true);
            p.prepare();
            p.start();
            player = p;
        } catch (Exception e) {
            player = null;
        }
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) {
                v.vibrate(VibrationEffect.createWaveform(new long[]{0, 700, 700}, 0));
            }
        } catch (Exception e) {
            // vibration is optional
        }
        main.removeCallbacks(ringStop);
        main.postDelayed(ringStop, 60000);
    }

    private void stopRingNow() {
        main.removeCallbacks(ringStop);
        if (player != null) {
            try {
                player.stop();
            } catch (Exception e) {
                // already stopped
            }
            try {
                player.release();
            } catch (Exception e) {
                // already released
            }
            player = null;
        }
        try {
            Vibrator v = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null) {
                v.cancel();
            }
        } catch (Exception e) {
            // vibration is optional
        }
    }

    /** The page tells us a call (or a missed/declined ring) is over. */
    @JavascriptInterface
    public void callEnded() {
        main.post(new Runnable() {
            @Override
            public void run() {
                MainActivity a = Hub.activity;
                if (a != null) {
                    a.onCallFinished();
                }
            }
        });
    }

    @JavascriptInterface
    public boolean canFullScreen() {
        if (Build.VERSION.SDK_INT < 34) {
            return true;
        }
        NotificationManager nm = nm();
        return nm != null && nm.canUseFullScreenIntent();
    }

    @JavascriptInterface
    public boolean isAppLock() {
        return ctx.getSharedPreferences("app", Context.MODE_PRIVATE).getBoolean("lock", false);
    }

    /** Turns the app lock on or off. Returns false if the phone has no screen lock to use. */
    @JavascriptInterface
    public boolean setAppLock(final boolean on) {
        if (on) {
            KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
            if (km == null || !km.isDeviceSecure()) {
                return false;
            }
        }
        ctx.getSharedPreferences("app", Context.MODE_PRIVATE).edit().putBoolean("lock", on).apply();
        main.post(new Runnable() {
            @Override
            public void run() {
                MainActivity a = Hub.activity;
                if (a != null) {
                    a.onLockChanged();
                }
            }
        });
        return true;
    }

    @JavascriptInterface
    public void keepScreenOn(final boolean on) {
        main.post(new Runnable() {
            @Override
            public void run() {
                MainActivity a = Hub.activity;
                if (a == null) {
                    return;
                }
                if (on) {
                    a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }
        });
    }

    /* ---------- settings and sharing ---------- */

    @JavascriptInterface
    public void openSettings(String kind) {
        String pkg = ctx.getPackageName();
        Intent i;
        if ("battery".equals(kind)) {
            i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg));
        } else if ("fullscreen".equals(kind) && Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + pkg));
        } else {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
            } catch (Exception ignored) {
                // nothing else to try
            }
        }
    }

    @JavascriptInterface
    public void share(String text) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        Intent chooser = Intent.createChooser(send, null);
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(chooser);
        } catch (Exception e) {
            // no app can share text
        }
    }
}
