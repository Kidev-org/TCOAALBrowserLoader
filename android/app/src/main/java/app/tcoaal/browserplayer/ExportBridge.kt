package app.tcoaal.browserplayer

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

/**
 * JS -> native bridge for downloading exported files (save-file exports,
 * global save exports, the loader's save-backup zip) on Android.
 *
 * The page's normal export path is Blob + <a download> + click(), which
 * works in a real browser but not reliably in this WebView: no
 * DownloadListener is registered, and UrlPolicy can't parse a host out of a
 * blob: URL, so the click gets routed to shouldOverrideUrlLoading and handed
 * to an external-app Intent that nothing can satisfy, it silently does
 * nothing. Exposed to the page as `window.AndroidExportBridge`.
 */
class ExportBridge(private val context: Context) {
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Page hands us the file as base64 + a filename + a MIME type. */
    @JavascriptInterface
    fun exportFile(base64: String, filename: String, mimeType: String) {
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: Exception) {
            return
        }
        // JavascriptInterface methods run on a WebView JS thread; both the
        // MediaStore write and startActivity need the main thread.
        mainHandler.post {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                if (!saveToDownloads(bytes, filename, mimeType)) {
                    shareFile(bytes, filename, mimeType)
                }
            } else {
                // Pre-API 29 has no permission-less MediaStore.Downloads path;
                // the share sheet works identically on every API level without
                // requesting storage permissions.
                shareFile(bytes, filename, mimeType)
            }
        }
    }

    /** API 29+: write straight into the public Downloads collection via
     *  MediaStore, no storage permission needed. Returns true on success. */
    private fun saveToDownloads(bytes: ByteArray, filename: String, mimeType: String): Boolean {
        return try {
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return false
            val wrote = resolver.openOutputStream(uri)?.use { out ->
                out.write(bytes)
                true
            } ?: false
            if (!wrote) return false
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            Toast.makeText(context, "Saved $filename to Downloads", Toast.LENGTH_LONG).show()
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Fallback (and the pre-API 29 path): write to the app's cache and hand
     *  it off via the system share sheet through a FileProvider content://
     *  URI, works on every API level, no storage permission required. */
    private fun shareFile(bytes: ByteArray, filename: String, mimeType: String) {
        try {
            val dir = File(context.cacheDir, "exports").apply { mkdirs() }
            val file = File(dir, filename)
            FileOutputStream(file).use { it.write(bytes) }
            val uri = FileProvider.getUriForFile(
                context, "${context.packageName}.fileprovider", file
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(send, "Save $filename"))
        } catch (e: Exception) {
            // No handler available; nothing more we can do.
        }
    }
}
