package ru.dvaryada.player

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Оболочка плеера «ДваРяда» для планшета.
 * Весь интерфейс приходит с ПК (http://<ПК>:8787/app/), поэтому обновляется вместе с ПК.
 * Здесь только: привязка по QR, поиск ПК в сети, полноэкранный режим и открытие ссылок.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var currentHost: String? = null
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("dvaryada", Context.MODE_PRIVATE) }

    private val scanner = registerForActivityResult(ScanContract()) { res ->
        val text = res.contents
        if (text != null) onScanned(text)
        else if (isPaired()) connect() else showSetup("")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        setupWeb()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (customView != null) { hideCustom(); return }
                web.evaluateJavascript("(window.drBack && window.drBack()) ? 'yes' : 'no'") { r ->
                    if (r == null || !r.contains("yes")) moveTaskToBack(true)
                }
            }
        })
        connect()
    }

    private fun isPaired() = !prefs.getString("token", null).isNullOrEmpty()

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWeb() {
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            allowFileAccess = true
        }
        web.setBackgroundColor(0xFF0D1113.toInt())
        web.addJavascriptInterface(Bridge(), "DvaRyadaApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "file") return false
                if (u.scheme == "http" && u.host == currentHost && u.path?.startsWith("/apk") != true) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && request.url.scheme == "http") {
                    main.post { showSetup("Нет связи с ПК. Проверьте, что он включён и планшет в той же Wi-Fi сети.", retry = true) }
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) = showCustom(view, callback)
            override fun onHideCustomView() = hideCustom()
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        }
    }

    /* ---------- полноэкранный режим (кнопка во весь экран в плеере) ---------- */
    private fun showCustom(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (customView != null) { callback.onCustomViewHidden(); return }
        customView = view
        customCallback = callback
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web.visibility = View.GONE
        immersive(true)
    }

    private fun hideCustom() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        web.visibility = View.VISIBLE
        customCallback?.onCustomViewHidden()
        customCallback = null
        immersive(false)
    }

    private fun immersive(on: Boolean) {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            c.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    /* ---------- экран привязки (assets/setup.html) ---------- */
    private fun showSetup(message: String, retry: Boolean = false, busy: Boolean = false) {
        currentHost = null
        val q = "m=" + Uri.encode(message) + "&r=" + (if (retry) 1 else 0) + "&b=" + (if (busy) 1 else 0) +
                "&p=" + (if (isPaired()) 1 else 0) + "&pc=" + Uri.encode(prefs.getString("pc", "") ?: "") +
                "&v=" + Uri.encode(BuildConfig.VERSION_NAME)
        web.loadUrl("file:///android_asset/setup.html?$q")
    }

    private fun startScan() {
        val o = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Наведите камеру на QR-код на экране ПК")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        scanner.launch(o)
    }

    /* ---------- связь с ПК ---------- */
    private fun ping(host: String, port: Int): Boolean = try {
        val c = URL("http://$host:$port/ping").openConnection() as HttpURLConnection
        c.connectTimeout = 1500
        c.readTimeout = 2000
        val ok = c.responseCode == 200 && c.inputStream.bufferedReader().use { it.readText() }.contains("dvaryada")
        c.disconnect()
        ok
    } catch (_: Exception) {
        false
    }

    private fun connect() {
        val token = prefs.getString("token", null)
        if (token.isNullOrEmpty()) { showSetup(""); return }
        val hosts = (prefs.getString("hosts", "") ?: "").split(",").filter { it.isNotBlank() }
        val port = prefs.getInt("port", 8787)
        showSetup("Ищу ПК в сети…", busy = true)
        io.execute {
            val host = hosts.firstOrNull { ping(it, port) }
            main.post {
                if (host == null) {
                    showSetup("ПК не найден. Он включён, программа ДваРяда запущена, а планшет в той же Wi-Fi сети?", retry = true)
                } else {
                    // удачный адрес — первым в списке, чтобы в следующий раз подключаться быстрее
                    prefs.edit().putString("hosts", (listOf(host) + hosts.filter { it != host }).joinToString(",")).apply()
                    currentHost = host
                    web.loadUrl("http://$host:$port/app/?k=" + Uri.encode(token))
                }
            }
        }
    }

    private fun onScanned(text: String) {
        val uri = Uri.parse(text.trim())
        if (uri.scheme != "dvaryada") {
            showSetup("Это другой QR-код. На ПК откройте «Настройки → Планшет → Привязать планшет» и отсканируйте правый код.")
            return
        }
        val hosts = (uri.getQueryParameter("h") ?: "").split(",").filter { it.isNotBlank() }
        val port = uri.getQueryParameter("p")?.toIntOrNull() ?: 8787
        val code = uri.getQueryParameter("c") ?: ""
        showSetup("Подключаюсь к ПК…", busy = true)
        io.execute {
            var err = "ПК не отвечает. Планшет и ПК должны быть в одной Wi-Fi сети, а Windows — разрешать доступ программе."
            for (h in hosts) {
                if (!ping(h, port)) continue
                try {
                    val c = URL("http://$h:$port/pair").openConnection() as HttpURLConnection
                    c.requestMethod = "POST"
                    c.doOutput = true
                    c.connectTimeout = 3000
                    c.readTimeout = 5000
                    c.setRequestProperty("Content-Type", "application/json")
                    val body = JSONObject().put("code", code).put("name", Build.MANUFACTURER + " " + Build.MODEL).toString()
                    c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    val stream = if (c.responseCode in 200..299) c.inputStream else c.errorStream
                    val j = JSONObject(stream.bufferedReader().use { it.readText() })
                    if (j.optBoolean("ok")) {
                        prefs.edit()
                            .putString("token", j.getString("token"))
                            .putString("hosts", (listOf(h) + hosts.filter { it != h }).joinToString(","))
                            .putInt("port", port)
                            .putString("pc", j.optString("name"))
                            .apply()
                        main.post { connect() }
                        return@execute
                    } else {
                        err = j.optString("error", err)
                    }
                } catch (e: Exception) {
                    err = "Ошибка связи с ПК: " + (e.message ?: e.javaClass.simpleName)
                }
            }
            val msg = err
            main.post { showSetup(msg) }
        }
    }

    /* ---------- мост для страницы: window.DvaRyadaApp ---------- */
    inner class Bridge {
        @JavascriptInterface fun scan() { main.post { startScan() } }
        @JavascriptInterface fun retry() { main.post { connect() } }
        @JavascriptInterface fun forget() { main.post { prefs.edit().clear().apply(); showSetup("") } }
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun paired(): Boolean = isPaired()
        @JavascriptInterface fun openUrl(url: String) {
            main.post { try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { } }
        }
    }

    override fun onDestroy() {
        io.shutdownNow()
        web.destroy()
        super.onDestroy()
    }
}
