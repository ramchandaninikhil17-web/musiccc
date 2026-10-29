package com.musicflow.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        const val DEFAULT_LOCAL_PC = "http://192.168.0.106:3000"
        const val DEFAULT_USB_LOCAL = "http://127.0.0.1:3000"
        const val DEFAULT_EMULATOR = "http://10.0.2.2:3000"
        const val DEFAULT_CLOUD_URL = "https://musiccc-59kv.onrender.com"

        const val DEFAULT_URL = DEFAULT_LOCAL_PC

        private const val PREFS_NAME = "musicflow_prefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val PERMISSION_REQUEST_NOTIFICATION = 1001
        private const val PERMISSION_REQUEST_STORAGE = 1002
        private const val FILE_CHOOSER_REQUEST = 1003
    }

    private lateinit var webView: WebView
    private lateinit var offlineView: ScrollView
    private lateinit var serverUrlInput: EditText
    private lateinit var connectButton: Button
    private lateinit var retryButton: Button
    private lateinit var connectionStatusText: TextView
    private lateinit var serverFab: ImageButton

    private lateinit var btnPresetWifi: Button
    private lateinit var btnPresetUsb: Button
    private lateinit var btnPresetEmulator: Button
    private lateinit var btnPresetCloud: Button

    private var playbackService: PlaybackService? = null
    private var serviceBound = false
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDownloadUrl: String? = null
    private var hasLoadedOnce = false
    private val networkExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    fun getServerUrl(): String {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getString(KEY_SERVER_URL, DEFAULT_URL) ?: DEFAULT_URL
    }

    fun setServerUrl(url: String) {
        val cleanUrl = normalizeServerUrl(url)
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER_URL, cleanUrl)
            .apply()
    }

    private fun normalizeServerUrl(rawUrl: String): String {
        var url = rawUrl.trim()
        if (url.isEmpty()) return DEFAULT_URL

        val isLocalOrIp = url.startsWith("192.168.") ||
                url.startsWith("10.") ||
                url.startsWith("172.") ||
                url.startsWith("127.0.0.1") ||
                url.startsWith("localhost") ||
                url.matches(Regex("""^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?.*""")) ||
                url.contains(":3000") ||
                url.contains(":8080") ||
                url.contains(":5000")

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = if (isLocalOrIp) "http://$url" else "https://$url"
        }
        return url.trimEnd('/')
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as PlaybackService.LocalBinder
            playbackService = binder.getService()
            serviceBound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            playbackService = null
            serviceBound = false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.parseColor("#0B0E14")

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        offlineView = findViewById(R.id.offlineView)
        serverUrlInput = findViewById(R.id.serverUrlInput)
        connectButton = findViewById(R.id.connectButton)
        retryButton = findViewById(R.id.retryButton)
        connectionStatusText = findViewById(R.id.connectionStatusText)
        serverFab = findViewById(R.id.serverFab)

        btnPresetWifi = findViewById(R.id.btnPresetWifi)
        btnPresetUsb = findViewById(R.id.btnPresetUsb)
        btnPresetEmulator = findViewById(R.id.btnPresetEmulator)
        btnPresetCloud = findViewById(R.id.btnPresetCloud)

        serverUrlInput.setText(getServerUrl())

        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        setupWebView()
        setupButtons()
        requestNotificationPermission()

        Intent(this, PlaybackService::class.java).also { intent ->
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
        }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            loadWebsite()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = webView.settings.userAgentString + " MusicFlowMobile/3.0 (Android)"
        }

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.addJavascriptInterface(WebAppInterface(), "MusicFlowAndroid")

        webView.webViewClient = MusicFlowWebViewClient()
        webView.webChromeClient = MusicFlowChromeClient()
        webView.setDownloadListener(MusicFlowDownloadListener())
    }

    private fun setupButtons() {
        connectButton.setOnClickListener {
            val entered = serverUrlInput.text.toString().trim()
            if (entered.isNotEmpty()) {
                val cleanUrl = normalizeServerUrl(entered)
                setServerUrl(cleanUrl)
                serverUrlInput.setText(cleanUrl)
                testAndConnect(cleanUrl)
            }
        }

        retryButton.setOnClickListener {
            val url = getServerUrl()
            testAndConnect(url)
        }

        serverFab.setOnClickListener {
            showChangeServerDialog()
        }

        btnPresetWifi.setOnClickListener {
            serverUrlInput.setText(DEFAULT_LOCAL_PC)
            setServerUrl(DEFAULT_LOCAL_PC)
            testAndConnect(DEFAULT_LOCAL_PC)
        }

        btnPresetUsb.setOnClickListener {
            serverUrlInput.setText(DEFAULT_USB_LOCAL)
            setServerUrl(DEFAULT_USB_LOCAL)
            testAndConnect(DEFAULT_USB_LOCAL)
        }

        btnPresetEmulator.setOnClickListener {
            serverUrlInput.setText(DEFAULT_EMULATOR)
            setServerUrl(DEFAULT_EMULATOR)
            testAndConnect(DEFAULT_EMULATOR)
        }

        btnPresetCloud.setOnClickListener {
            serverUrlInput.setText(DEFAULT_CLOUD_URL)
            setServerUrl(DEFAULT_CLOUD_URL)
            testAndConnect(DEFAULT_CLOUD_URL)
        }
    }

    private fun testAndConnect(targetUrl: String) {
        connectionStatusText.visibility = View.VISIBLE
        connectionStatusText.setTextColor(Color.parseColor("#93C5FD"))
        connectionStatusText.text = "Testing connection to $targetUrl…"

        networkExecutor.execute {
            var reachable = false
            var message = ""
            try {
                val testUrl = if (targetUrl.endsWith("/")) "${targetUrl}api/health" else "$targetUrl/api/health"
                val connection = (URL(testUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 3500
                    readTimeout = 3500
                    requestMethod = "GET"
                    instanceFollowRedirects = true
                }
                val code = connection.responseCode
                reachable = (code in 200..399)
                message = if (reachable) "Connected! Loading MusicFlow…" else "Server responded with code $code"
            } catch (e: IOException) {
                try {
                    val rootConn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 3000
                        readTimeout = 3000
                        requestMethod = "GET"
                    }
                    val code = rootConn.responseCode
                    reachable = (code in 200..399)
                    message = if (reachable) "Connected! Loading MusicFlow…" else "Server returned HTTP $code"
                } catch (err: Exception) {
                    reachable = false
                    message = "Could not reach server. Verify PC server is running and both devices share Wi-Fi."
                }
            } catch (e: Exception) {
                reachable = false
                message = "Connection error: ${e.message}"
            }

            mainHandler.post {
                if (reachable) {
                    connectionStatusText.setTextColor(Color.parseColor("#34D399"))
                    connectionStatusText.text = message
                    hasLoadedOnce = false
                    mainHandler.postDelayed({
                        offlineView.visibility = View.GONE
                        webView.visibility = View.VISIBLE
                        serverFab.visibility = View.VISIBLE
                        webView.loadUrl(targetUrl)
                    }, 400)
                } else {
                    connectionStatusText.setTextColor(Color.parseColor("#F87171"))
                    connectionStatusText.text = message
                    Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun showChangeServerDialog() {
        val input = EditText(this).apply {
            setText(getServerUrl())
            hint = "http://192.168.0.106:3000"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            setSingleLine(true)
            val padding = (16 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
        }

        AlertDialog.Builder(this, androidx.appcompat.R.style.Theme_AppCompat_Dialog_Alert)
            .setTitle(R.string.server_url_dialog_title)
            .setMessage(R.string.server_url_dialog_message)
            .setView(input)
            .setPositiveButton(R.string.save_and_connect) { _, _ ->
                val entered = input.text.toString().trim()
                if (entered.isNotEmpty()) {
                    val cleanUrl = normalizeServerUrl(entered)
                    setServerUrl(cleanUrl)
                    serverUrlInput.setText(cleanUrl)
                    hasLoadedOnce = false
                    Toast.makeText(this, "Connecting to $cleanUrl...", Toast.LENGTH_SHORT).show()
                    testAndConnect(cleanUrl)
                }
            }
            .setNeutralButton("Presets") { _, _ ->
                showOfflineView()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun loadWebsite() {
        val url = getServerUrl()
        if (isNetworkAvailable()) {
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            serverFab.visibility = View.VISIBLE
            webView.loadUrl(url)
        } else {
            showOfflineView()
        }
    }

    private fun showOfflineView() {
        webView.visibility = View.GONE
        offlineView.visibility = View.VISIBLE
        serverFab.visibility = View.GONE
        serverUrlInput.setText(getServerUrl())
    }

    private fun isNetworkAvailable(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val network = cm.activeNetwork ?: return false
            val capabilities = cm.getNetworkCapabilities(network) ?: return false
            return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        } else {
            @Suppress("DEPRECATION")
            val networkInfo = cm.activeNetworkInfo
            @Suppress("DEPRECATION")
            return networkInfo?.isConnected == true
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    PERMISSION_REQUEST_NOTIFICATION
                )
            }
        }
    }

    // ---- WebView Clients ----

    private inner class MusicFlowWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            serverFab.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            hasLoadedOnce = true

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.setBackgroundDrawableResource(R.color.mf_bg)
            }

            injectNativeBridge()
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?
        ) {
            if (request?.isForMainFrame == true) {
                if (!hasLoadedOnce) {
                    showOfflineView()
                }
            }
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?
        ): Boolean {
            val url = request?.url?.toString() ?: return false
            val currentServer = getServerUrl()

            val uri = Uri.parse(url)
            val host = uri.host ?: ""

            if (url.startsWith(currentServer) ||
                host == "localhost" ||
                host == "127.0.0.1" ||
                host == "10.0.2.2" ||
                host.startsWith("192.168.") ||
                host.startsWith("10.") ||
                host.startsWith("172.") ||
                host.contains("onrender.com") ||
                host.contains("musicwalahnar.com") ||
                url.startsWith(DEFAULT_CLOUD_URL)
            ) {
                return false
            }

            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Exception) {}
            return true
        }
    }

    private inner class MusicFlowChromeClient : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            fileUploadCallback?.onReceiveValue(null)
            fileUploadCallback = filePathCallback

            val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "audio/*"
                addCategory(Intent.CATEGORY_OPENABLE)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }

            intent.type = "audio/*"
            intent.putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("audio/mpeg", "audio/flac", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/*")
            )

            try {
                startActivityForResult(intent, FILE_CHOOSER_REQUEST)
            } catch (e: Exception) {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = null
                Toast.makeText(this@MainActivity, "Cannot open file picker", Toast.LENGTH_SHORT).show()
            }
            return true
        }
    }

    private inner class MusicFlowDownloadListener : DownloadListener {
        override fun onDownloadStart(
            url: String?,
            userAgent: String?,
            contentDisposition: String?,
            mimeType: String?,
            contentLength: Long
        ) {
            if (url == null) return

            try {
                val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setMimeType(mimeType)
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url))
                    setTitle(filename)
                    setDescription("Downloading $filename")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "MusicFlow/$filename")
                }

                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this@MainActivity, "Downloading: $filename", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun injectNativeBridge() {
        val js = """
        (function() {
            if (window._musicFlowBridgeInjected) return;
            window._musicFlowBridgeInjected = true;
            
            var origSetMetadata = null;
            if (navigator.mediaSession) {
                var metaDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata');
                if (metaDesc && metaDesc.set) {
                    origSetMetadata = metaDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'metadata', {
                        set: function(meta) {
                            origSetMetadata.call(this, meta);
                            if (meta && window.MusicFlowAndroid) {
                                try {
                                    window.MusicFlowAndroid.onMediaMetadata(
                                        meta.title || '',
                                        meta.artist || '',
                                        meta.album || '',
                                        (meta.artwork && meta.artwork.length > 0) ? meta.artwork[meta.artwork.length - 1].src : ''
                                    );
                                } catch(e) {}
                            }
                        },
                        get: metaDesc.get ? metaDesc.get.bind(navigator.mediaSession) : function() { return null; },
                        configurable: true
                    });
                }

                var stateDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'playbackState');
                if (stateDesc && stateDesc.set) {
                    var origSetState = stateDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'playbackState', {
                        set: function(state) {
                            origSetState.call(this, state);
                            if (window.MusicFlowAndroid) {
                                try {
                                    window.MusicFlowAndroid.onPlaybackStateChanged(state === 'playing');
                                } catch(e) {}
                            }
                        },
                        get: stateDesc.get ? stateDesc.get.bind(navigator.mediaSession) : function() { return 'none'; },
                        configurable: true
                    });
                }
            }
            
            function monitorAudio(audio) {
                if (audio._mfMonitored) return;
                audio._mfMonitored = true;
                audio.addEventListener('play', function() {
                    if (window.MusicFlowAndroid) {
                        try { window.MusicFlowAndroid.onPlaybackStateChanged(true); } catch(e) {}
                    }
                });
                audio.addEventListener('pause', function() {
                    if (window.MusicFlowAndroid) {
                        try { window.MusicFlowAndroid.onPlaybackStateChanged(false); } catch(e) {}
                    }
                });
                audio.addEventListener('ended', function() {
                    if (window.MusicFlowAndroid) {
                        try { window.MusicFlowAndroid.onPlaybackStateChanged(false); } catch(e) {}
                    }
                });
            }
            
            document.querySelectorAll('audio').forEach(monitorAudio);
            var origCreate = document.createElement;
            document.createElement = function(tag) {
                var el = origCreate.call(document, tag);
                if (tag.toLowerCase() === 'audio') {
                    setTimeout(function() { monitorAudio(el); }, 0);
                }
                return el;
            };
        })();
        """.trimIndent()

        webView.evaluateJavascript(js, null)
    }

    @Suppress("unused")
    inner class WebAppInterface {
        @JavascriptInterface
        fun onMediaMetadata(title: String, artist: String, album: String, artworkUrl: String) {
            playbackService?.updateMetadata(title, artist, album, artworkUrl)
        }

        @JavascriptInterface
        fun onPlaybackStateChanged(isPlaying: Boolean) {
            if (isPlaying) {
                playbackService?.startPlayback()
            } else {
                playbackService?.pausePlayback()
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return BuildConfig.VERSION_NAME
        }

        @JavascriptInterface
        fun isNativeApp(): Boolean {
            return true
        }

        @JavascriptInterface
        fun openServerSettings() {
            runOnUiThread {
                showChangeServerDialog()
            }
        }
    }

    private val webViewCommandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "com.musicflow.mobile.WEBVIEW_COMMAND") {
                val js = intent.getStringExtra("js") ?: return
                runOnUiThread {
                    webView.evaluateJavascript(js, null)
                }
            }
        }
    }

    private val mediaButtonReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
                val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }

                if (keyEvent?.action == KeyEvent.ACTION_DOWN) {
                    when (keyEvent.keyCode) {
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                        KeyEvent.KEYCODE_HEADSETHOOK -> {
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_NEXT -> {
                            webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                            webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_PLAY -> {
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        }
                        KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        }
                    }
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()

        val cmdFilter = IntentFilter("com.musicflow.mobile.WEBVIEW_COMMAND")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(webViewCommandReceiver, cmdFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(webViewCommandReceiver, cmdFilter)
        }

        val mediaFilter = IntentFilter(Intent.ACTION_MEDIA_BUTTON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(mediaButtonReceiver, mediaFilter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(mediaButtonReceiver, mediaFilter)
        }
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(webViewCommandReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(mediaButtonReceiver) } catch (_: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        webView.destroy()
    }

    @Deprecated("Deprecated in API 33+")
    override fun onBackPressed() {
        if (offlineView.visibility == View.VISIBLE && hasLoadedOnce) {
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            serverFab.visibility = View.VISIBLE
            return
        }
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_HEADSETHOOK -> {
                webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_NEXT -> {
                webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated in API 33+")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (resultCode == RESULT_OK && data != null) {
                val results = mutableListOf<Uri>()
                data.clipData?.let { clipData ->
                    for (i in 0 until clipData.itemCount) {
                        results.add(clipData.getItemAt(i).uri)
                    }
                } ?: data.data?.let { uri ->
                    results.add(uri)
                }
                fileUploadCallback?.onReceiveValue(results.toTypedArray())
            } else {
                fileUploadCallback?.onReceiveValue(null)
            }
            fileUploadCallback = null
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            PERMISSION_REQUEST_STORAGE -> {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    pendingDownloadUrl?.let { url ->
                        webView.loadUrl(url)
                        pendingDownloadUrl = null
                    }
                }
            }
        }
    }
}
