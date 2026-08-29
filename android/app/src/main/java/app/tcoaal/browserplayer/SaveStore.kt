package app.tcoaal.browserplayer

import java.io.File

/**
 * Persists a small JSON snapshot of the player's saves to the app sandbox.
 *
 * This single file, and only this file, is included in Android Auto Backup
 * (see res/xml/backup_rules.xml + data_extraction_rules.xml), so saves survive a
 * factory reset or a move to a new device. The large game-file IndexedDB (under
 * app_webview) is deliberately excluded: it exceeds the 25 MB backup cap and is
 * re-importable from the user's own game folder.
 *
 * Pure java.io so it is covered by JVM unit tests against a temp directory.
 */
class SaveStore(private val file: File) {

    /** Writes [json] atomically (temp + rename). Empty / "{}" snapshots are ignored. */
    fun write(json: String?) {
        if (json.isNullOrBlank() || json.trim() == "{}") return
        val tmp = File(file.parentFile, file.name + ".tmp")
        try {
            tmp.writeText(json, Charsets.UTF_8)
            if (!tmp.renameTo(file)) {
                file.writeText(json, Charsets.UTF_8)
                tmp.delete()
            }
        } catch (_: Exception) {
            tmp.delete()
        }
    }

    /** Returns the stored snapshot, or null if absent / empty / unreadable. */
    fun read(): String? {
        return try {
            if (!file.exists()) null else file.readText(Charsets.UTF_8).ifBlank { null }
        } catch (_: Exception) {
            null
        }
    }

    /** True when a non-trivial snapshot is present. */
    fun hasData(): Boolean {
        val s = read() ?: return false
        return s.isNotBlank() && s.trim() != "{}"
    }

    companion object {
        const val FILE_NAME = "save-backup.json"
    }
}
