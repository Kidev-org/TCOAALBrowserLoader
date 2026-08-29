package app.tcoaal.browserplayer

import android.webkit.JavascriptInterface

/**
 * JS <-> native bridge for save mirroring. Exposed to the page as
 * `window.AndroidSaveBridge`. Methods are invoked on a WebView JS thread, so the
 * file I/O in [SaveStore] runs off the main thread; the restore callback hops
 * back to the main thread inside the activity.
 *
 * Only two narrow methods are exposed, both touching nothing but the local save
 * mirror, so the attack surface from the (trusted, first-party) page is minimal.
 */
class SaveBridge(
    private val store: SaveStore,
    private val onRestore: (String) -> Unit
) {
    /** Page hands us the current saves as a JSON object string. */
    @JavascriptInterface
    fun onSavesExported(json: String?) {
        store.write(json)
    }

    /** Page asks (on load) for any cloud-backed saves to be restored. */
    @JavascriptInterface
    fun onRestoreRequested() {
        val json = store.read() ?: return
        onRestore(json)
    }
}
