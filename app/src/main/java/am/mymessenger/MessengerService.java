package am.mymessenger;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.WebView;

/** Keeps the app process (and the messenger page inside it) alive while the app is closed. */
public class MessengerService extends Service {

    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /** Every 15 s pokes the page so its link to the server stays alive while the page is throttled in the background. */
    private final Runnable keepAlive = new Runnable() {
        @Override
        public void run() {
            WebView w = Hub.webView;
            if (w != null) {
                try {
                    w.evaluateJavascript("window.__keepAlive&&window.__keepAlive()", null);
                } catch (Exception ignored) {
                    // the page is not ready yet
                }
            }
            handler.postDelayed(this, 15000);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        NativeBridge.createChannels(this);

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new Notification.Builder(this, NativeBridge.CH_SERVICE)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("KHOSQ")
                .setContentText("Աշխատում է. նամակներն ու զանգերը կհասնեն")
                .setContentIntent(pi)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NativeBridge.NOTE_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NativeBridge.NOTE_SERVICE, n);
        }

        Hub.ensure(this);
        handler.removeCallbacks(keepAlive);
        handler.postDelayed(keepAlive, 15000);

        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mymessenger:link");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Exception e) {
            wakeLock = null; // without the permission the service still works
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(keepAlive);
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }
}
