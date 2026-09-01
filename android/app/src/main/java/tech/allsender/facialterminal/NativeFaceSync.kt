package tech.allsender.facialterminal

import android.content.Context
import androidx.room.withTransaction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** Persists a server face-sync response without exposing biometric data. */
suspend fun persistFaceSyncPayload(context: Context, payloadJson: String): Boolean = withContext(Dispatchers.IO) {
    try {
        val payload = JSONObject(payloadJson)
        val branchId = payload.optString("branch_id")
        val pairedBranch = SecureStore(context).getSecret("branch_id")
        if (branchId.isBlank() || pairedBranch != branchId) return@withContext false

        val version = payload.optLong("version", 0L)
        if (version < 0L) return@withContext false
        val database = LocalDatabase.get(context)
        val faces = database.faceTemplates()
        val secureStore = SecureStore(context)
        val upserts = payload.optJSONArray("upsert")
        val deleted = payload.optJSONArray("deleted")
        val prepared = mutableListOf<FaceTemplateEntity>()

        // Validar y cifrar todo antes de tocar la base. Una respuesta parcial o
        // corrupta nunca debe dejar una sucursal con un catálogo incompleto.
        if (upserts != null) {
            for (index in 0 until upserts.length()) {
                val item = upserts.optJSONObject(index) ?: return@withContext false
                if (!validFaceTemplate(item, branchId)) return@withContext false
                prepared += FaceTemplateEntity(
                    key = "$branchId:${item.optString("employee_id")}",
                    branchId = branchId,
                    employeeId = item.optString("employee_id"),
                    version = item.optLong("version", version),
                    encryptedPayload = secureStore.encrypt(item.toString()),
                )
            }
        }

        database.withTransaction {
            if (payload.optBoolean("full_sync", false)) {
                faces.clearBranch(branchId)
            }
            prepared.forEach { faces.upsert(it) }
            if (deleted != null) {
                for (index in 0 until deleted.length()) {
                    val item = deleted.optJSONObject(index) ?: continue
                    if (item.optString("branch_id") == branchId && item.optString("employee_id").isNotBlank()) {
                        faces.delete("$branchId:${item.optString("employee_id")}")
                    }
                }
            }
            faces.saveMetadata(SyncMetadataEntity(branchId, version, System.currentTimeMillis()))
        }
        true
    } catch (_: Exception) {
        false
    }
}

private fun validFaceTemplate(item: JSONObject, branchId: String): Boolean {
    if (item.optString("branch_id") != branchId || item.optString("employee_id").isBlank()) return false
    if (item.optString("model_name") != "opencv_sface_v1") return false
    if (!item.optBoolean("active", false)) return false
    val embeddings = item.optJSONArray("embeddings") ?: return false
    if (embeddings.length() == 0) return false
    for (index in 0 until embeddings.length()) {
        val vector = embeddings.optJSONArray(index) ?: return false
        if (vector.length() != 128) return false
        for (part in 0 until vector.length()) {
            val value = vector.optDouble(part, Double.NaN)
            if (!value.isFinite()) return false
        }
    }
    return true
}
