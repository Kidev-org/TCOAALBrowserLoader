package app.tcoaal.browserplayer

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Tiny single-purpose loopback HTTP/1.1 server for the hermetic service-worker
 * test. Binds to 127.0.0.1, which browsers treat as a secure context, so service
 * workers are permitted over plain http with no certificate.
 *
 * [routes] maps an exact path to (mimeType, bytes).
 */
class LocalHttpServer(private val routes: Map<String, Pair<String, ByteArray>>) {

    private lateinit var server: ServerSocket

    @Volatile
    private var running = false

    val port: Int get() = server.localPort

    fun start() {
        server = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        running = true
        thread(isDaemon = true) {
            while (running) {
                val socket = try {
                    server.accept()
                } catch (e: Exception) {
                    break
                }
                try {
                    handle(socket)
                } catch (_: Exception) {
                    // best-effort; ignore broken connections
                }
            }
        }
    }

    fun stop() {
        running = false
        try {
            server.close()
        } catch (_: Exception) {
        }
    }

    private fun handle(socket: Socket) {
        socket.use { s ->
            val reader = BufferedReader(InputStreamReader(s.getInputStream()))
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val path = parts[1].substringBefore('?')
            // Drain the rest of the request headers.
            while (true) {
                val header = reader.readLine() ?: break
                if (header.isEmpty()) break
            }
            val route = routes[path]
            val out = s.getOutputStream()
            if (route == null) {
                write(out, 404, "text/plain", ByteArray(0))
            } else {
                write(out, 200, route.first, route.second)
            }
        }
    }

    private fun write(out: OutputStream, code: Int, mime: String, body: ByteArray) {
        val reason = if (code == 200) "OK" else "Not Found"
        val header = buildString {
            append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n")
            append("Content-Type: ").append(mime).append("\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            // Allow a root-scoped worker even though sw.js is served from "/sw.js".
            append("Service-Worker-Allowed: /\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }
        out.write(header.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }
}
