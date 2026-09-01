package tech.allsender.facialterminal

import android.content.Context
import android.os.BatteryManager
import android.webkit.JavascriptInterface
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Narrow bridge consumed by the existing facial PWA.
 *
 * The bridge never exposes the Keystore key or biometric payloads back to
 * JavaScript. It only accepts validated JSON and stores it encrypted locally.
 */
class AllSenderAndroidBridge(context: Context) {
    private val appContext = context.applicationContext
    private val database = LocalDatabase.get(appContext)
    private val secureStore = SecureStore(appContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @JavascriptInterface
    fun getPlatformLabel(): String = "android-terminal"

    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getBatteryPercent(): Int {
        val manager = appContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        return manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }

    @JavascriptInterface
    fun isCharging(): Boolean {
        val intent = appContext.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
            ?: return false
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    }

    @JavascriptInterface
    fun getPairingCode(): String = secureStore.getSecret("pairing_code").orEmpty()

    @JavascriptInterface
    fun hasLocalFaceEngine(): Boolean {
        return LocalFaceEngine.isAvailable(appContext)
    }

    @JavascriptInterface
    fun recognizeLocal(imageDataUrl: String, contextJson: String): String {
        return try {
            val request = JSONObject(contextJson)
            val pairedBranch = secureStore.getSecret("branch_id")
            if (pairedBranch.isNullOrBlank() || request.optString("branch_id") != pairedBranch) {
                return "null"
            }
            LocalFaceEngine.recognize(appContext, imageDataUrl, request)?.toString() ?: "null"
        } catch (_: Exception) {
            "null"
        }
    }

    @JavascriptInterface
    fun markPaired(token: String?, branchId: String?, terminalId: String?) {
        if (!token.isNullOrBlank() && token.length >= 20) secureStore.putSecret("terminal_token", token)
        if (!branchId.isNullOrBlank()) secureStore.putSecret("branch_id", branchId)
        if (!terminalId.isNullOrBlank()) secureStore.putSecret("terminal_id", terminalId)
        TerminalSyncScheduler.schedulePeriodic(appContext)
    }

    @JavascriptInterface
    fun clearPairingCode() = secureStore.removeSecret("pairing_code")

    @JavascriptInterface
    fun clearLocalFaceData(branchId: String?) {
        if (branchId.isNullOrBlank()) return
        scope.launch {
            database.faceTemplates().clearBranch(branchId)
            database.faceTemplates().clearMetadata(branchId)
        }
    }

    @JavascriptInterface
    fun storeFaceSync(payloadJson: String): Boolean {
        val payload = try { JSONObject(payloadJson) } catch (_: Exception) { return false }
        val branchId = payload.optString("branch_id")
        if (branchId.isBlank() || secureStore.getSecret("branch_id") != branchId) return false
        scope.launch { persistFaceSyncPayload(appContext, payloadJson) }
        return true
    }

    @JavascriptInterface
    fun queueOfflinePunch(payloadJson: String): Boolean {
        return try {
            val payload = JSONObject(payloadJson)
            val eventId = payload.optString("local_event_id")
            val branchId = payload.optString("branch_id")
            val terminalId = payload.optString("terminal_id")
            if (eventId.isBlank() || branchId.isBlank() || terminalId.isBlank()) return false
            if (payload.optString("mode") != "OFFLINE") return false
            val pairedBranch = secureStore.getSecret("branch_id")
            val pairedTerminal = secureStore.getSecret("terminal_id")
            if (pairedBranch != branchId || pairedTerminal != terminalId) return false
            scope.launch {
                database.offlinePunches().insert(
                    OfflinePunchEntity(
                        localEventId = eventId,
                        branchId = branchId,
                        terminalId = terminalId,
                        encryptedPayload = secureStore.encrypt(payload.toString()),
                    ),
                )
                TerminalSyncScheduler.requestNow(appContext)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun requestSync() {
        TerminalSyncScheduler.requestNow(appContext)
    }

    @JavascriptInterface
    fun clearPaired() {
        scope.launch {
            database.offlinePunches().clearAll()
            secureStore.clearTerminalSecrets()
        }
    }
}
