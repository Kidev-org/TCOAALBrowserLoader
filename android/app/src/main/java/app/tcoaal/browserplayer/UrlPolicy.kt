package app.tcoaal.browserplayer

import java.net.URI

/**
 * Pure navigation policy: decide whether a URL stays inside the embedded WebView
 * (our own app content) or is handed off to the system browser (external links).
 *
 * Uses java.net.URI (not android.net.Uri) so it is exercised directly by JVM unit
 * tests without an emulator.
 */
object UrlPolicy {
    const val BASE_HOST = "tcoaal.app"

    /** True when [url] is app content that should render in the WebView. */
    fun isInternal(url: String?): Boolean {
        val host = hostOf(url) ?: return false
        return host == BASE_HOST ||
            host.endsWith(".$BASE_HOST") ||
            host == "127.0.0.1" ||
            host == "localhost"
    }

    /** Lowercased host of [url], or null if it cannot be parsed / has no host. */
    fun hostOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return try {
            URI(url).host?.lowercase()
        } catch (_: Exception) {
            null
        }
    }
}
