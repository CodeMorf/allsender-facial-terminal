package tech.allsender.facialterminal

import android.Manifest
import android.annotation.SuppressLint
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: AllSenderAndroidBridge
    private var pendingGeolocation: Pair<String, GeolocationPermissions.Callback>? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        pendingGeolocation?.let { (origin, callback) ->
            val allowed = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            callback.invoke(origin, allowed, false)
            pendingGeolocation = null
        }
        webView.reload()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersiveMode()

        bridge = AllSenderAndroidBridge(this)
        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString AllSenderFacialAndroid/1.0.0"
        }
        webView.addJavascriptInterface(bridge, "AllSenderAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (url.startsWith(BuildConfig.BASE_URL)) {
                    view.evaluateJavascript(
                        """
                        (() => {
                          const nativeBridge = window.AllSenderAndroid;
                          if (!nativeBridge || !nativeBridge.hasLocalFaceEngine || !nativeBridge.hasLocalFaceEngine()) {
                            delete window.AllSenderFacialLocal;
                            return;
                          }
                          window.AllSenderFacialLocal = {
                            recognize(imageDataUrl, context) {
                              const raw = nativeBridge.recognizeLocal(imageDataUrl, JSON.stringify(context));
                              if (!raw) return null;
                              try { return JSON.parse(raw); } catch (_) { return null; }
                            }
                          };
                        })();
                        """.trimIndent(),
                        null,
                    )
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return request.url.host != "nomina.allsender.tech"
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
                        hasPermission(Manifest.permission.CAMERA)
                    ) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        request.deny()
                    }
                }
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeolocation = origin to callback
                    requestRuntimePermissions()
                }
            }
        }
        setContentView(webView)
        webView.loadUrl("${BuildConfig.BASE_URL}/facial-terminal")
        requestRuntimePermissions()
        TerminalSyncScheduler.schedulePeriodic(this)
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) permissions += Manifest.permission.POST_NOTIFICATIONS
        val missing = permissions.filterNot(::hasPermission).toTypedArray()
        if (missing.isNotEmpty()) permissionLauncher.launch(missing)
    }

    private fun enterImmersiveMode() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
        val policy = getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        if (policy?.isLockTaskPermitted(packageName) == true) {
            startLockTask()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersiveMode()
    }

    @SuppressLint("MissingSuperCall")
    override fun onBackPressed() {
        // A terminal must not navigate away from the facial route.
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}
