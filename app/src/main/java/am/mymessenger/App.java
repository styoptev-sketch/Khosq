package am.mymessenger;

import android.app.Application;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;

/** Saves the text of a crash so the next start can show it. */
public class App extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        final File out = new File(getFilesDir(), "crash.txt");
        final Thread.UncaughtExceptionHandler old = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    FileWriter w = new FileWriter(out);
                    w.write("Android " + android.os.Build.VERSION.RELEASE + " (API "
                            + android.os.Build.VERSION.SDK_INT + ") " + android.os.Build.MODEL
                            + "\nthread: " + t.getName() + "\n" + sw);
                    w.close();
                } catch (Throwable ignored) {
                    // nothing more can be done
                }
                if (old != null) old.uncaughtException(t, e);
            }
        });
    }
}
