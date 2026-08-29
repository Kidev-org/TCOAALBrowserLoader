package app.tcoaal.browserplayer

import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The de-risk gate. Proves, in a real Android WebView, the one thing the whole
 * BrowserPlayer architecture depends on: a page-registered service worker that
 * INTERCEPTS fetches; plus that IndexedDB writes succeed (save persistence).
 *
 * Fully hermetic: a loopback HTTP server on 127.0.0.1 (a secure context) serves
 * the fixture, so no network and no certificate are required. Run on an
 * emulator/device: ./gradlew connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class ServiceWorkerSmokeTest {

    private lateinit var server: LocalHttpServer
    private var webView: WebView? = null
    private val latch = CountDownLatch(1)

    @Volatile
    private var result: String = ""

    inner class Probe {
        @JavascriptInterface
        fun result(value: String) {
            result = value
            latch.countDown()
        }
    }

    private fun asset(name: String): ByteArray =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("fixture/$name").use { it.readBytes() }

    @Before
    fun setUp() {
        server = LocalHttpServer(
            mapOf(
                "/" to ("text/html" to asset("index.html")),
                "/sw.js" to ("application/javascript" to asset("sw.js"))
            )
        )
        server.start()
    }

    @After
    fun tearDown() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView?.destroy()
        }
        server.stop()
    }

    @Test
    fun serviceWorkerInterceptsFetchAndIdbPersists() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val wv = WebView(instrumentation.targetContext)
            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            @Suppress("DEPRECATION")
            wv.settings.databaseEnabled = true
            wv.addJavascriptInterface(Probe(), "AndroidProbe")
            wv.loadUrl("http://127.0.0.1:${server.port}/")
            webView = wv
        }

        assertTrue("timed out waiting for the page probe", latch.await(30, TimeUnit.SECONDS))
        assertTrue(
            "service worker did not intercept the fetch (result=$result)",
            result.contains("FETCH=INTERCEPTED")
        )
        assertTrue(
            "IndexedDB write did not succeed (result=$result)",
            result.contains("IDB=OK")
        )
    }
}
