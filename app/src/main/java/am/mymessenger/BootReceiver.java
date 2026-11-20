package am.mymessenger;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the background service again after the phone restarts. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            try {
                context.startForegroundService(new Intent(context, MessengerService.class));
            } catch (Exception e) {
                // Android may refuse a background start; the app still starts when opened.
            }
        }
    }
}
