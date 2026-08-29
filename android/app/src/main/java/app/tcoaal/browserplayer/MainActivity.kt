package app.tcoaal.browserplayer

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File

/**
 * A thin, durable browser for https://tcoaal.app.
 *
 * Why a WebView wrapper instead of a PWA/TWA: the WebView's storage lives in this
 * app's private sandbox (app_webview/), so it is never subject to browser storage
 * eviction (Chrome pressure, Safari ITP). The only durability gap left, surviving
 * a factory reset, is closed by mirroring saves to a tiny native file that rides
 * Android Auto Backup (see SaveStore / SaveBridge / assets/save-sync.js).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var saveStore: SaveStore
    private val mainHandler = Handler(Looper.getMainLooper())

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var fileChooser: ActivityResultLauncher<Intent>

    private val periodicExport = object : Runnable {
        override fun run() {
            exportSaves()
            mainHandler.postDelayed(this, EXPORT_INTERVAL_MS)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        saveStore = SaveStore(File(filesDir, SaveStore.FILE_NAME))

        fileChooser = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val cb = filePathCallback
            filePathCallback = null
            cb?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
        }

        webView = WebView(this)
        setContentView(webView)
        enterFullscreen()
        configureWebView()
        enableServiceWorkers()

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.addJavascriptInterface(
            SaveBridge(saveStore) { json -> restoreSaves(json) },
            "AndroidSaveBridge"
        )
        webView.addJavascriptInterface(ExportBridge(this), "AndroidExportBridge")

        webView.settings.apply {
            // TCOAALApp/1 is the stable, version-agnostic in-app marker matched by
            // the web loader and lang-shim; TCOAALVer/<versionName> carries the real
            // installed version so the loader can offer an update when a newer APK
            // has been released. Read from PackageManager (no BuildConfig needed).
            userAgentString = "$userAgentString TCOAALApp/1 TCOAALVer/$appVersionName"
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url?.toString()
                if (UrlPolicy.isInternal(url)) return false
                url?.let { openExternally(it) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                injectSaveSync()
            }

            // A fresh install opened with no connection cannot reach
            // https://tcoaal.app/, and the service-worker app shell has never
            // been cached, so the WebView would show its raw error page. Swap in
            // a themed offline notice instead. Once the app has been loaded
            // online once, the SW serves the loader offline and this never fires.
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (!request.isForMainFrame) return
                if (!UrlPolicy.isInternal(request.url?.toString())) return
                view.loadDataWithBaseURL(
                    START_URL, offlineHtml, "text/html", "UTF-8", START_URL
                )
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // The game's www/ is imported as a .zip via the loader's file input.
            // (Folder import uses webkitdirectory, which Android WebView cannot
            // satisfy; users must pick the .zip on mobile.)
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    fileChooser.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }
    }

    /** Themed offline page (assets/offline.html), read once and reused. Falls
     *  back to a minimal inline notice if the asset cannot be read. */
    private val offlineHtml: String by lazy {
        try {
            assets.open("offline.html").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            "<html><body style=\"background:#121212;color:#d3d0c0;" +
                "font-family:Georgia,serif;text-align:center;padding:40px\">" +
                "<h1>No connection</h1><p>Start the game once with an internet " +
                "connection before it can run offline.</p></body></html>"
        }
    }

    /** Installed app version (from the package), e.g. "1.2.0". Falls back to "1"
     *  when it cannot be read, so the loader still sees a well-formed token. */
    private val appVersionName: String
        get() = try {
            @Suppress("DEPRECATION")
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1"
        } catch (e: Exception) {
            "1"
        }

    /** The asset-decryption pipeline relies on a service worker; make sure the
     *  WebView's SW engine is active and may read app content. */
    private fun enableServiceWorkers() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) return
        val controller = ServiceWorkerControllerCompat.getInstance()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_CONTENT_ACCESS)) {
            controller.serviceWorkerWebSettings.allowContentAccess = true
        }
        controller.setServiceWorkerClient(object : ServiceWorkerClientCompat() {
            override fun shouldInterceptRequest(request: WebResourceRequest) = null
        })
    }

    private fun injectSaveSync() {
        val js = try {
            assets.open("save-sync.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            return
        }
        webView.evaluateJavascript(js, null)
    }

    private fun exportSaves() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            "window.__nativeSaveSync && window.__nativeSaveSync.export();",
            null
        )
    }

    private fun restoreSaves(json: String) {
        // Invoked from the JS bridge thread; evaluateJavascript must run on main.
        mainHandler.post {
            val literal = JSONObject.quote(json) // safe, escaped JS string literal
            webView.evaluateJavascript(
                "window.__nativeSaveSync && window.__nativeSaveSync.import($literal);",
                null
            )
        }
    }

    private fun openExternally(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            // No handling app; silently ignore.
        }
    }

    private fun enterFullscreen() {
        WindowInsetsControllerCompat(window, window.decorView).let { ctrl ->
            ctrl.hide(WindowInsetsCompat.Type.systemBars())
            ctrl.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterFullscreen()
    }

    override fun onResume() {
        super.onResume()
        mainHandler.postDelayed(periodicExport, EXPORT_INTERVAL_MS)
    }

    override fun onPause() {
        mainHandler.removeCallbacks(periodicExport)
        exportSaves()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val START_URL = "https://tcoaal.app/"
        const val EXPORT_INTERVAL_MS = 60_000L
    }
}
