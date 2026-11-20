package am.mymessenger;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Process-wide holder. The messenger page lives in one WebView that outlives the activity,
 * so the connection keeps running while the app is closed or the phone is locked.
 */
final class Hub {
    static final String HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + HOST + "/assets/index.html";

    static WebView webView;
    static MainActivity activity;
    static boolean visible = false;
    static String pendingChat = null;

    private Hub() {
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    static synchronized WebView ensure(Context context) {
        if (webView != null) {
            return webView;
        }
        final Context app = context.getApplicationContext();
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(app))
                .build();

        WebView w = new WebView(app);
        w.setBackgroundColor(Color.TRANSPARENT);

        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        // Keep the page's process at high priority even when the activity is not on screen.
        w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Never leave the app page.
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                MainActivity a = activity;
                if (a == null || !HOST.equals(request.getOrigin().getHost())) {
                    request.deny();
                    return;
                }
                a.handlePermissionRequest(request);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                MainActivity a = activity;
                if (a == null) {
                    callback.onReceiveValue(null);
                    return true;
                }
                return a.pickFile(callback);
            }
        });

        w.addJavascriptInterface(new NativeBridge(app), "Android");
        w.loadUrl(START_URL);
        webView = w;
        return w;
    }
}
