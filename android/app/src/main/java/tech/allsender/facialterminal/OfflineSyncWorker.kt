package tech.allsender.facialterminal

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Delivers the native durable queue; the server remains the authority. */
class OfflineSyncWorker(appContext: Context, workerParams: WorkerParameters) :
    CoroutineWorker(appContext, workerParams) {
    private val database = LocalDatabase.get(appContext)
    private val secureStore = SecureStore(appContext)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val token = secureStore.getSecret("terminal_token") ?: return@withContext Result.success()
        val branchId = secureStore.getSecret("branch_id")
        val faceSyncResult = if (!branchId.isNullOrBlank()) syncFaceTemplates(token, branchId) else Result.success()
        if (faceSyncResult != null) return@withContext faceSyncResult

        val events = database.offlinePunches().pending(100)
        if (events.isEmpty()) return@withContext Result.success()
        events.forEach { database.offlinePunches().setState(it.localEventId, "SYNCING") }
        try {
            val body = JSONObject().put("events", JSONArray().apply {
                events.forEach { event ->
                    secureStore.decrypt(event.encryptedPayload)?.let { put(JSONObject(it)) }
                }
            }).toString()
            val connection = (URL("${BuildConfig.BASE_URL}/api/v1/facial/terminals/offline-punches/sync").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 30_000
                doOutput = true
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("X-Facial-Terminal-Token", token)
            }
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val responseText = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            connection.disconnect()
            if (status == 401 || status == 403 || status == 409) {
                events.forEach { database.offlinePunches().markFailed(it.localEventId, "La terminal necesita vincularse nuevamente.") }
                return@withContext Result.failure()
            }
            if (status !in 200..299) {
                events.forEach { database.offlinePunches().markRetry(it.localEventId, "Backend temporalmente no disponible ($status).") }
                return@withContext Result.retry()
            }
            val items = JSONObject(responseText).optJSONArray("items")
            val seen = mutableSetOf<String>()
            if (items != null) {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index) ?: continue
                    val id = item.optString("local_event_id")
                    val event = events.firstOrNull { it.localEventId == id } ?: continue
                    seen += id
                    if (item.optString("status") == "SYNCED") {
                        database.offlinePunches().delete(event.localEventId)
                    } else if (item.optBoolean("retryable", false)) {
                        database.offlinePunches().markRetry(
                            event.localEventId,
                            item.optString("message", "Se reintentará este marcaje."),
                        )
                    } else {
                        database.offlinePunches().markFailed(
                            event.localEventId,
                            item.optString("message", "El backend rechazó el marcaje."),
                        )
                    }
                }
            }
            events.filterNot { seen.contains(it.localEventId) }.forEach {
                database.offlinePunches().markRetry(it.localEventId, "El backend no devolvió estado; se reintentará.")
            }
            if (events.any { !seen.contains(it.localEventId) }) Result.retry() else Result.success()
        } catch (_: Exception) {
            events.forEach { database.offlinePunches().markRetry(it.localEventId, "No se pudo contactar el backend; se reintentará.") }
            Result.retry()
        }
    }

    /** Refreshes the branch-scoped face snapshot even when the WebView is closed. */
    private suspend fun syncFaceTemplates(token: String, branchId: String): Result? {
        return try {
            val version = database.faceTemplates().metadata(branchId)?.facesVersion ?: 0L
            val connection = (URL("${BuildConfig.BASE_URL}/api/v1/facial/terminals/faces/sync?since_version=$version").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("X-Facial-Terminal-Token", token)
            }
            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            connection.disconnect()
            if (status == 401 || status == 403 || status == 409) return Result.failure()
            if (status !in 200..299) return Result.retry()
            val payload = JSONObject(body)
            if (payload.optString("branch_id") != branchId || payload.optString("terminal_id").isBlank()) return Result.retry()
            if (!persistFaceSyncPayload(applicationContext, body)) return Result.retry()
            null
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
