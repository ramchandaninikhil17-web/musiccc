package com.musicflow.player

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
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.media.AudioManager
import android.media.MediaScannerConnection
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.nio.ByteBuffer
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.palette.graphics.Palette
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        const val LOCAL_PORT = 8765
        const val LOCAL_URL = "http://127.0.0.1:$LOCAL_PORT"
        private const val PERMISSION_REQUEST_NOTIFICATION = 1001
        private const val PERMISSION_REQUEST_AUDIO = 1002
    }

    private lateinit var webView: WebView
    private lateinit var offlineView: LinearLayout
    private lateinit var retryButton: Button

    private var localServer: LocalServer? = null
    private var playbackService: PlaybackService? = null
    private var serviceBound = false
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var hasLoadedOnce = false

    // Native Speech Recognizer & Text-to-Speech (Hey Ruby AI)
    private var speechRecognizer: SpeechRecognizer? = null
    private var textToSpeech: TextToSpeech? = null
    private var isSpeechListening = false
    private var isAlwaysListeningMode = false

    private val executor = Executors.newSingleThreadExecutor()

    // File picker launcher using modern Activity Result API
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri>? ->
        fileUploadCallback?.onReceiveValue(uris?.toTypedArray())
        fileUploadCallback = null
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            if (service is PlaybackService.LocalBinder) {
                playbackService = service.getService()
                serviceBound = true
                Log.i(TAG, "Connected to PlaybackService")
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            playbackService = null
            serviceBound = false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full display cutout mode: punch hole and notch metrics are accurately resolved
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.parseColor("#0B0E14")
        window.navigationBarColor = Color.parseColor("#0B0E14")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        )

        setContentView(R.layout.activity_main)

        // Safe insets listener ensures WebView never overlaps camera punch hole or status bar
        val rootLayout = findViewById<FrameLayout>(R.id.rootLayout)
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val navInsets = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
            view.setPadding(insets.left, insets.top, insets.right, navInsets.bottom)
            windowInsets
        }

        webView = findViewById(R.id.webView)
        offlineView = findViewById(R.id.offlineView)
        retryButton = findViewById(R.id.retryButton)

        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        setupWebView()
        initTextToSpeech()
        retryButton.setOnClickListener { startServerAndLoad() }
        requestAppPermissions()

        // Bind Foreground PlaybackService for native background audio & lock-screen controls
        Intent(this, PlaybackService::class.java).also { intent ->
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
            startService(intent)
        }

        startServerAndLoad()
    }

    // ── Local Embedded Standalone Server ──

    private fun startServerAndLoad() {
        offlineView.visibility = View.GONE
        webView.visibility = View.VISIBLE

        executor.execute {
            try {
                localServer?.stop()
                localServer = LocalServer(this@MainActivity, LOCAL_PORT)
                localServer?.start()
                Log.i(TAG, "Standalone on-device server running on port $LOCAL_PORT")

                Thread.sleep(250)

                runOnUiThread {
                    webView.loadUrl(LOCAL_URL)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start local server: ${e.message}", e)
                runOnUiThread {
                    Toast.makeText(this, "Server start error: ${e.message}", Toast.LENGTH_LONG).show()
                    showOffline()
                }
            }
        }
    }

    // ── WebView Setup ──

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
            offscreenPreRaster = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
        }

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val bridge = WebAppInterface()
        webView.addJavascriptInterface(bridge, "MusicFlowBridge")
        webView.addJavascriptInterface(bridge, "MusicFlowAndroid")
        webView.webViewClient = MusicFlowWebViewClient()
        webView.webChromeClient = MusicFlowChromeClient()
        webView.setDownloadListener(MusicFlowDownloadListener())
    }

    private fun showOffline() {
        webView.visibility = View.GONE
        offlineView.visibility = View.VISIBLE
    }

    private fun requestAppPermissions() {
        val perms = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                perms.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            perms.add(Manifest.permission.RECORD_AUDIO)
        }
        if (perms.isNotEmpty()) {
            ActivityCompat.requestPermissions(
                this,
                perms.toTypedArray(),
                PERMISSION_REQUEST_NOTIFICATION
            )
        }
    }

    // ── Dynamic Dominant-Color Extraction (Album Art → Palette) ──

    private fun extractDominantColor(artworkUrl: String) {
        if (artworkUrl.isEmpty()) return
        executor.execute {
            try {
                val resolvedUrl = if (artworkUrl.startsWith("//")) "https:$artworkUrl"
                else if (artworkUrl.startsWith("/")) "http://127.0.0.1:$LOCAL_PORT$artworkUrl"
                else artworkUrl
                val stream = URL(resolvedUrl).openStream()
                val bitmap = BitmapFactory.decodeStream(stream)
                stream.close()

                if (bitmap != null) {
                    Palette.from(bitmap).generate { palette ->
                        val vibrant = palette?.vibrantSwatch ?: palette?.dominantSwatch
                        if (vibrant != null) {
                            val colorHex = String.format("#%06X", (0xFFFFFF and vibrant.rgb))
                            runOnUiThread {
                                webView.evaluateJavascript(
                                    """
                                    (function() {
                                        if (document.documentElement) {
                                            document.documentElement.style.setProperty('--dominant-color', '$colorHex');
                                        }
                                        var glow = document.getElementById('sfpArtGlow');
                                        if (glow) {
                                            glow.style.background = 'radial-gradient(circle, $colorHex 0%, transparent 70%)';
                                        }
                                        var fullPlayer = document.getElementById('spotifyFullscreenPlayer');
                                        if (fullPlayer) {
                                            fullPlayer.style.background = 'linear-gradient(180deg, ${colorHex}44 0%, #0B0E14 65%)';
                                        }
                                    })();
                                    """.trimIndent(),
                                    null
                                )
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Palette extract notice: ${e.message}")
            }
        }
    }

    // ── Native Speech Recognition Engine (Hey Ruby AI) ──

    private fun initTextToSpeech() {
        try {
            textToSpeech = TextToSpeech(applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    textToSpeech?.language = Locale.US
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "TTS init error: ${e.message}")
        }
    }

    private fun speakNativeText(text: String) {
        if (text.isEmpty()) return
        try {
            textToSpeech?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ruby_tts_${System.currentTimeMillis()}")
        } catch (e: Exception) {
            Log.w(TAG, "TTS speak error: ${e.message}")
        }
    }

    private fun startNativeSpeechListening(always: Boolean) {
        isAlwaysListeningMode = always
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            Log.w(TAG, "SpeechRecognizer is not available on this device")
            sendSpeechEvent("onError", "not_available")
            return
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST_AUDIO)
            return
        }

        try {
            // Mute system notification and system sound streams temporarily during startListening
            // to suppress Android's recognition earcon beep ("tada")
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            try {
                audioManager?.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_MUTE, 0)
                audioManager?.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_MUTE, 0)
            } catch (e: Exception) {}

            if (speechRecognizer == null) {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(applicationContext)
                speechRecognizer?.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        isSpeechListening = true
                        // Unmute once microphone is active
                        try {
                            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                            am?.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE, 0)
                            am?.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_UNMUTE, 0)
                        } catch (e: Exception) {}
                        sendSpeechEvent("onReady", "")
                    }
                    override fun onBeginningOfSpeech() {
                        sendSpeechEvent("onBeginning", "")
                    }
                    override fun onRmsChanged(rmsdB: Float) {
                        sendSpeechEvent("onRmsChanged", rmsdB.toString())
                    }
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {
                        isSpeechListening = false
                        sendSpeechEvent("onEndOfSpeech", "")
                    }
                    override fun onError(error: Int) {
                        isSpeechListening = false
                        // Unmute on error as safety
                        try {
                            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                            am?.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE, 0)
                            am?.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_UNMUTE, 0)
                        } catch (e: Exception) {}
                        sendSpeechEvent("onError", "code_$error")
                    }
                    override fun onResults(results: Bundle?) {
                        isSpeechListening = false
                        // Unmute on completion as safety
                        try {
                            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                            am?.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE, 0)
                            am?.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_UNMUTE, 0)
                        } catch (e: Exception) {}
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val text = matches?.firstOrNull() ?: ""
                        sendSpeechEvent("onResult", text)
                    }
                    override fun onPartialResults(partialResults: Bundle?) {
                        val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val text = matches?.firstOrNull() ?: ""
                        sendSpeechEvent("onPartial", text)
                    }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
            }

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            }
            speechRecognizer?.startListening(intent)
            isSpeechListening = true
        } catch (e: Exception) {
            Log.e(TAG, "startSpeechListening error: ${e.message}", e)
            isSpeechListening = false
        }
    }

    private fun stopNativeSpeechListening() {
        isAlwaysListeningMode = false
        isSpeechListening = false
        try {
            speechRecognizer?.stopListening()
            speechRecognizer?.cancel()
        } catch (e: Exception) {}
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            am?.adjustStreamVolume(AudioManager.STREAM_NOTIFICATION, AudioManager.ADJUST_UNMUTE, 0)
            am?.adjustStreamVolume(AudioManager.STREAM_SYSTEM, AudioManager.ADJUST_UNMUTE, 0)
        } catch (e: Exception) {}
    }

    private fun sendSpeechEvent(type: String, data: String) {
        val safeData = data.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", "")
        val js = "if(window.MusicFlowNativeSpeech && typeof window.MusicFlowNativeSpeech.handleNativeSpeechEvent === 'function'){ window.MusicFlowNativeSpeech.handleNativeSpeechEvent('$type', '$safeData'); } else if(window.VoiceAssistant && typeof window.VoiceAssistant.handleNativeSpeech === 'function'){ window.VoiceAssistant.handleNativeSpeech('$type', '$safeData'); }"
        runOnUiThread {
            webView.evaluateJavascript(js, null)
        }
    }

    // ── WebView Clients ──

    private inner class MusicFlowWebViewClient : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            super.onPageStarted(view, url, favicon)
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            hasLoadedOnce = true
            injectNativeBridge()
        }

        override fun onReceivedError(
            view: WebView?, request: WebResourceRequest?, error: WebResourceError?
        ) {
            if (request?.isForMainFrame == true && !hasLoadedOnce) {
                showOffline()
            }
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?, request: WebResourceRequest?
        ): Boolean {
            val url = request?.url?.toString() ?: return false
            if (url.startsWith(LOCAL_URL) || url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
                return false
            }
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) {}
            return true
        }
    }

    private inner class MusicFlowChromeClient : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest?) {
            runOnUiThread {
                try {
                    request?.grant(request.resources)
                } catch (e: Exception) {
                    Log.w(TAG, "PermissionRequest grant error: ${e.message}")
                }
            }
        }

        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            fileUploadCallback?.onReceiveValue(null)
            fileUploadCallback = filePathCallback
            filePickerLauncher.launch("audio/*")
            return true
        }
    }

    // ── Native Downloads (Supports Video + Audio Muxing & Pure Audio) ──

    private fun downloadStreamToFile(
        client: okhttp3.OkHttpClient,
        streamUrl: String,
        destFile: File,
        onProgress: (percent: Int, downloadedBytes: Long, totalBytes: Long) -> Unit
    ): Boolean {
        destFile.parentFile?.mkdirs()
        val resolvedUrl = if (streamUrl.startsWith("/")) "http://127.0.0.1:$LOCAL_PORT$streamUrl" else streamUrl
        val req = okhttp3.Request.Builder()
            .url(resolvedUrl)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .header("Referer", "https://www.youtube.com/")
            .header("Origin", "https://www.youtube.com")
            .build()

        try {
            val resp = client.newCall(req).execute()
            val cType = resp.header("Content-Type") ?: ""
            if (!resp.isSuccessful || resp.body == null || cType.startsWith("text/html") || cType.startsWith("application/json")) {
                val code = resp.code
                resp.close()
                throw Exception("HTTP $code ($cType) for download stream")
            }

            val body = resp.body!!
            val totalBytes = body.contentLength()
            body.byteStream().use { input ->
                FileOutputStream(destFile).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    var downloaded: Long = 0
                    var lastUpdate = System.currentTimeMillis()
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read
                        val now = System.currentTimeMillis()
                        if (now - lastUpdate > 500) {
                            lastUpdate = now
                            val pct = if (totalBytes > 0) ((downloaded * 100) / totalBytes).toInt() else 0
                            onProgress(pct, downloaded, totalBytes)
                        }
                    }
                    output.flush()
                    val finalPct = if (totalBytes > 0) ((downloaded * 100) / totalBytes).toInt() else 100
                    onProgress(finalPct, downloaded, totalBytes)
                }
            }
            return true
        } catch (e: Exception) {
            if (destFile.exists()) destFile.delete()
            throw e
        }
    }

    private fun muxVideoAndAudio(videoFile: File, audioFile: File, outputFile: File): Boolean {
        var videoExtractor: MediaExtractor? = null
        var audioExtractor: MediaExtractor? = null
        var muxer: MediaMuxer? = null
        var muxerStarted = false
        try {
            outputFile.parentFile?.mkdirs()
            videoExtractor = MediaExtractor().apply { setDataSource(videoFile.absolutePath) }
            audioExtractor = MediaExtractor().apply { setDataSource(audioFile.absolutePath) }

            muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

            var videoTrackIndex = -1
            var muxerVideoTrackIndex = -1
            for (i in 0 until videoExtractor.trackCount) {
                val format = videoExtractor.getTrackFormat(i)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("video/")) {
                    videoTrackIndex = i
                    muxerVideoTrackIndex = muxer.addTrack(format)
                    videoExtractor.selectTrack(i)
                    break
                }
            }

            var audioTrackIndex = -1
            var muxerAudioTrackIndex = -1
            for (i in 0 until audioExtractor.trackCount) {
                val format = audioExtractor.getTrackFormat(i)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("audio/")) {
                    audioTrackIndex = i
                    muxerAudioTrackIndex = muxer.addTrack(format)
                    audioExtractor.selectTrack(i)
                    break
                }
            }

            if (videoTrackIndex == -1 || muxerVideoTrackIndex == -1) {
                Log.e(TAG, "No video track found in ${videoFile.name}")
                return false
            }

            val hasAudio = (audioTrackIndex != -1 && muxerAudioTrackIndex != -1)

            muxer.start()
            muxerStarted = true

            val bufferSize = 2 * 1024 * 1024
            val byteBuffer = ByteBuffer.allocateDirect(bufferSize)
            val bufferInfo = MediaCodec.BufferInfo()

            var videoDone = false
            var audioDone = !hasAudio
            var baseVideoTime = -1L
            var baseAudioTime = -1L

            while (!videoDone || !audioDone) {
                val rawV = if (!videoDone) videoExtractor.sampleTime else Long.MAX_VALUE
                val rawA = if (!audioDone) audioExtractor.sampleTime else Long.MAX_VALUE

                val vPts = if (!videoDone) {
                    if (rawV >= 0 && baseVideoTime >= 0) maxOf(0L, rawV - baseVideoTime) else rawV
                } else Long.MAX_VALUE

                val aPts = if (!audioDone) {
                    if (rawA >= 0 && baseAudioTime >= 0) maxOf(0L, rawA - baseAudioTime) else rawA
                } else Long.MAX_VALUE

                if (!videoDone && (audioDone || vPts <= aPts)) {
                    bufferInfo.offset = 0
                    bufferInfo.size = videoExtractor.readSampleData(byteBuffer, 0)
                    if (bufferInfo.size < 0) {
                        videoDone = true
                    } else {
                        val sampleTime = videoExtractor.sampleTime
                        if (baseVideoTime < 0 && sampleTime >= 0) {
                            baseVideoTime = sampleTime
                        }
                        val pts = if (sampleTime >= 0) {
                            if (baseVideoTime >= 0) maxOf(0L, sampleTime - baseVideoTime) else sampleTime
                        } else {
                            0L
                        }
                        bufferInfo.presentationTimeUs = pts
                        bufferInfo.flags = videoExtractor.sampleFlags
                        muxer.writeSampleData(muxerVideoTrackIndex, byteBuffer, bufferInfo)
                        videoExtractor.advance()
                    }
                } else if (!audioDone) {
                    bufferInfo.offset = 0
                    bufferInfo.size = audioExtractor.readSampleData(byteBuffer, 0)
                    if (bufferInfo.size < 0) {
                        audioDone = true
                    } else {
                        val sampleTime = audioExtractor.sampleTime
                        if (baseAudioTime < 0 && sampleTime >= 0) {
                            baseAudioTime = sampleTime
                        }
                        val pts = if (sampleTime >= 0) {
                            if (baseAudioTime >= 0) maxOf(0L, sampleTime - baseAudioTime) else sampleTime
                        } else {
                            0L
                        }
                        bufferInfo.presentationTimeUs = pts
                        bufferInfo.flags = audioExtractor.sampleFlags
                        muxer.writeSampleData(muxerAudioTrackIndex, byteBuffer, bufferInfo)
                        audioExtractor.advance()
                    }
                }
            }

            muxer.stop()
            muxerStarted = false
            Log.i(TAG, "Successfully muxed video and audio into ${outputFile.name} (hasAudio=$hasAudio, size=${outputFile.length()})")
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Error muxing video and audio: ${e.message}", e)
            if (outputFile.exists()) outputFile.delete()
            return false
        } finally {
            try { videoExtractor?.release() } catch (e: Exception) {}
            try { audioExtractor?.release() } catch (e: Exception) {}
            try {
                if (muxerStarted) muxer?.stop()
                muxer?.release()
            } catch (e: Exception) {}
        }
    }

    fun performNativeDownload(url: String, title: String, artist: String, format: String, quality: String) {
        val isVideo = format.equals("video", ignoreCase = true) || url.contains("format=video")
        val ext = if (isVideo) "mp4" else "mp3"
        val mime = if (isVideo) "video/mp4" else "audio/mpeg"
        val subDirType = if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_MUSIC
        val cleanTitle = (title.ifEmpty { "Media" }).replace(Regex("[^a-zA-Z0-9 _.-]"), "").trim().ifEmpty { "Track" }
        val filename = "$cleanTitle.$ext"
        val resolvedUrl = if (url.startsWith("/")) {
            "http://127.0.0.1:${LOCAL_PORT}$url"
        } else url

        runOnUiThread {
            Toast.makeText(this@MainActivity, "⬇ Starting download: $cleanTitle (${if (isVideo) "${quality}p Video (with Sound)" else "${quality} kbps Audio"})", Toast.LENGTH_SHORT).show()
        }

        executor.execute {
            val notifId = (System.currentTimeMillis() % 100000).toInt() + 2000
            val notifManager = getSystemService(Context.NOTIFICATION_SERVICE) as? android.app.NotificationManager
            val notifBuilder = androidx.core.app.NotificationCompat.Builder(this@MainActivity, MusicFlowApp.CHANNEL_DOWNLOAD)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Downloading $cleanTitle")
                .setContentText("Preparing ${if (isVideo) "${quality}p Video (Audio + Video)" else "${quality} kbps Audio"}...")
                .setOngoing(true)
                .setProgress(100, 0, true)
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)

            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                    notifManager?.notify(notifId, notifBuilder.build())
                }
            } catch (e: Exception) {}

            try {
                val client = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(45, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(600, java.util.concurrent.TimeUnit.SECONDS)
                    .followRedirects(true)
                    .build()

                var targetDir = File(Environment.getExternalStoragePublicDirectory(subDirType), "MusicFlow")
                if (!targetDir.exists()) targetDir.mkdirs()
                if (!targetDir.canWrite()) {
                    targetDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MusicFlow")
                    if (!targetDir.exists()) targetDir.mkdirs()
                }
                if (!targetDir.canWrite()) {
                    targetDir = getExternalFilesDir(subDirType) ?: filesDir
                }

                val targetFile = File(targetDir, filename)

                val videoId = Regex("""/api/download/([a-zA-Z0-9_-]{11})""").find(url)?.groupValues?.get(1)
                    ?: Regex("""[?&]v=([a-zA-Z0-9_-]{11})""").find(url)?.groupValues?.get(1)
                    ?: ""

                if (isVideo && videoId.isNotEmpty()) {
                    // Query video-pair endpoint to check if adaptive streams need audio muxing
                    var pairObj: JsonObject? = null
                    try {
                        val pairUrl = "http://127.0.0.1:${LOCAL_PORT}/api/video-pair/$videoId?quality=$quality"
                        val pairReq = okhttp3.Request.Builder().url(pairUrl).build()
                        val pairResp = client.newCall(pairReq).execute()
                        val pairBody = pairResp.body?.string()
                        pairResp.close()
                        if (pairResp.isSuccessful && !pairBody.isNullOrEmpty()) {
                            pairObj = JsonParser.parseString(pairBody).asJsonObject
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Video-pair fetch note: ${e.message}")
                    }

                    val isProgressive = pairObj?.get("isProgressive")?.asBoolean ?: false
                    val vUrl = pairObj?.get("videoUrl")?.asString
                    val aUrl = pairObj?.get("audioUrl")?.asString
                    val fps = pairObj?.get("fps")?.asInt ?: 30
                    val fpsLabel = if (fps >= 48) " ${fps}FPS Ultra" else if (fps > 30) " ${fps}FPS" else ""

                    if (!isProgressive && !aUrl.isNullOrEmpty() && !vUrl.isNullOrEmpty()) {
                        // YouTube DASH adaptive: Download video track and audio track separately, then mux into MP4
                        val tempDir = cacheDir
                        val tempVid = File(tempDir, "temp_vid_${System.currentTimeMillis()}.mp4")
                        val tempAud = File(tempDir, "temp_aud_${System.currentTimeMillis()}.m4a")
                        try {
                            // Phase 1: Download Video Track (0% -> 75%)
                            notifBuilder.setContentText("Downloading video$fpsLabel (0%)...").setProgress(100, 0, false)
                            try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                            downloadStreamToFile(client, vUrl, tempVid) { pct, bytes, total ->
                                val overall = (pct * 0.75).toInt()
                                notifBuilder.setProgress(100, overall, total <= 0)
                                    .setContentText("Downloading video$fpsLabel: $pct% (${bytes / (1024 * 1024)} MB)")
                                try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                            }

                            // Phase 2: Download Audio Track (75% -> 95%)
                            notifBuilder.setContentText("Downloading audio (0%)...").setProgress(100, 75, false)
                            try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                            downloadStreamToFile(client, aUrl, tempAud) { pct, bytes, total ->
                                val overall = 75 + (pct * 0.20).toInt()
                                notifBuilder.setProgress(100, overall, total <= 0)
                                    .setContentText("Downloading audio: $pct% (${bytes / 1024} KB)")
                                try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                            }

                            // Phase 3: Hardware Muxing into single MP4 file with audio
                            notifBuilder.setContentText("Merging audio & video (${quality}p$fpsLabel)...").setProgress(100, 96, true)
                            try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                            val muxSuccess = muxVideoAndAudio(tempVid, tempAud, targetFile)
                            if (!muxSuccess) {
                                if (tempVid.exists()) {
                                    tempVid.copyTo(targetFile, overwrite = true)
                                } else {
                                    throw Exception("Failed to merge audio and video tracks")
                                }
                            }
                        } finally {
                            try { tempVid.delete() } catch (e: Exception) {}
                            try { tempAud.delete() } catch (e: Exception) {}
                        }
                    } else {
                        // Progressive or single stream
                        val streamUrl = if (!vUrl.isNullOrEmpty()) vUrl else resolvedUrl
                        downloadStreamToFile(client, streamUrl, targetFile) { pct, bytes, total ->
                            notifBuilder.setProgress(100, pct, total <= 0)
                                .setContentText("Downloading video: $pct% (${bytes / (1024 * 1024)} MB)")
                            try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                        }
                    }
                } else {
                    // Audio download (MP3 / M4A)
                    downloadStreamToFile(client, resolvedUrl, targetFile) { pct, bytes, total ->
                        notifBuilder.setProgress(100, pct, total <= 0)
                            .setContentText("Downloading audio: $pct% (${bytes / (1024 * 1024)} MB)")
                        try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}
                    }
                }

                MediaScannerConnection.scanFile(
                    this@MainActivity,
                    arrayOf(targetFile.absolutePath),
                    arrayOf(mime)
                ) { path, uri ->
                    Log.i(TAG, "Indexed downloaded file: $path -> $uri")
                }

                notifBuilder.setContentTitle("✅ Download Complete")
                    .setContentText("Saved: $filename to ${targetDir.name}/MusicFlow")
                    .setProgress(0, 0, false)
                    .setOngoing(false)
                    .setAutoCancel(true)
                try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}

                runOnUiThread {
                    Toast.makeText(this@MainActivity, "✅ Saved with Sound: $filename in ${targetDir.name}/MusicFlow", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Native download failed: ${e.message}", e)
                notifBuilder.setContentTitle("❌ Download Failed")
                    .setContentText(e.message ?: "Could not complete download")
                    .setProgress(0, 0, false)
                    .setOngoing(false)
                    .setAutoCancel(true)
                try { notifManager?.notify(notifId, notifBuilder.build()) } catch (e: Exception) {}

                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
    private inner class MusicFlowDownloadListener : DownloadListener {
        override fun onDownloadStart(
            url: String?, userAgent: String?, contentDisposition: String?,
            mimeType: String?, contentLength: Long
        ) {
            if (url == null) return
            try {
                val filename = URLUtil.guessFileName(url, contentDisposition, mimeType ?: "audio/mpeg")
                val isVideo = filename.endsWith(".mp4", ignoreCase = true) || (mimeType?.contains("video") == true)
                val cleanTitle = filename.substringBeforeLast(".")
                performNativeDownload(url, cleanTitle, "", if (isVideo) "video" else "audio", if (isVideo) "1080" else "192")
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ── Native Bridge Injection ──

    private fun injectNativeBridge() {
        val js = """
        (function() {
            if (window._musicFlowNativeBridgeInjected) return;
            window._musicFlowNativeBridgeInjected = true;

            window.MusicFlowBridge = window.MusicFlowBridge || window.MusicFlowAndroid;
            // Signal to web app that it is running inside the Android APK shell
            document.documentElement.classList.add('is-mobile-app');
            if (document.body) document.body.classList.add('is-mobile-app');

            // Native Speech Event Handler Bridge
            window.MusicFlowNativeSpeech = {
                handleNativeSpeechEvent: function(type, data) {
                    if (window.VoiceAssistant && typeof window.VoiceAssistant.handleNativeSpeech === 'function') {
                        window.VoiceAssistant.handleNativeSpeech(type, data);
                    }
                }
            };

            // Hook MediaSession metadata and playbackState for native track synchronization
            if (navigator.mediaSession) {
                var metaDesc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata');
                if (metaDesc && metaDesc.set) {
                    var origSetMeta = metaDesc.set;
                    Object.defineProperty(navigator.mediaSession, 'metadata', {
                        set: function(meta) {
                            origSetMeta.call(this, meta);
                            if (meta && window.MusicFlowAndroid) {
                                try {
                                    var art = (meta.artwork && meta.artwork.length > 0) ? meta.artwork[meta.artwork.length - 1].src : '';
                                    var dur = (window.audioPlayer && window.audioPlayer.duration) ? Math.round(window.audioPlayer.duration * 1000) : 0;
                                    window.MusicFlowAndroid.updateMetadata(
                                        meta.title || '',
                                        meta.artist || '',
                                        meta.album || '',
                                        art,
                                        dur
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
                                window.MusicFlowAndroid.updatePlaybackState(state === 'playing');
                            }
                        },
                        get: stateDesc.get ? stateDesc.get.bind(navigator.mediaSession) : function() { return 'none'; },
                        configurable: true
                    });
                }

                if (typeof navigator.mediaSession.setPositionState === 'function') {
                    var origSetPos = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
                    navigator.mediaSession.setPositionState = function(state) {
                        origSetPos(state);
                        if (window.MusicFlowAndroid && state) {
                            try {
                                var posMs = Math.round((state.position || 0) * 1000);
                                var durMs = Math.round((state.duration || 0) * 1000);
                                window.MusicFlowAndroid.updatePosition(posMs, durMs);
                            } catch(e) {}
                        }
                    };
                }
            }
        })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    // ── JavaScript Interface Exposing Native Android Engine ──

    @Suppress("unused")
    inner class WebAppInterface {
        @JavascriptInterface
        fun updatePlaybackState(playing: Boolean) {
            runOnUiThread {
                if (playing) {
                    playbackService?.startPlayback()
                } else {
                    playbackService?.pausePlayback()
                }
            }
        }

        @JavascriptInterface
        fun updateMetadata(title: String, artist: String, album: String, artworkUrl: String, durationMs: Long) {
            runOnUiThread {
                playbackService?.updateMetadata(title, artist, album, artworkUrl, durationMs)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun updatePosition(posMs: Long, durMs: Long) {
            runOnUiThread {
                playbackService?.updatePosition(posMs, durMs)
            }
        }

        @JavascriptInterface
        fun onTrackChange(id: String, title: String, artist: String, album: String, artworkUrl: String, streamUrl: String) {
            runOnUiThread {
                playbackService?.updateMetadata(title, artist, album, artworkUrl)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun playTrack(id: String, title: String, artist: String, album: String, artworkUrl: String, streamUrl: String) {
            runOnUiThread {
                playbackService?.updateMetadata(title, artist, album, artworkUrl)
                extractDominantColor(artworkUrl)
            }
        }

        @JavascriptInterface
        fun pauseTrack() {
            runOnUiThread { playbackService?.pausePlayback() }
        }

        @JavascriptInterface
        fun resumeTrack() {
            runOnUiThread { playbackService?.startPlayback() }
        }

        @JavascriptInterface
        fun togglePlayPause() {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
            }
        }

        @JavascriptInterface
        fun seekTo(positionSec: Float) {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof audioPlayer!=='undefined'&&audioPlayer){audioPlayer.currentTime=$positionSec;}", null)
            }
        }

        @JavascriptInterface
        fun setPlaybackSpeed(speed: Float) {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof audioPlayer!=='undefined'&&audioPlayer){audioPlayer.playbackRate=$speed;}", null)
            }
        }

        @JavascriptInterface
        fun updateQueue(queueJson: String) {
            runOnUiThread {
                playbackService?.updateQueue(queueJson)
            }
        }

        @JavascriptInterface
        fun nextTrack() {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
            }
        }

        @JavascriptInterface
        fun prevTrack() {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
            }
        }

        @JavascriptInterface
        fun setSleepTimer(minutes: Int) {
            runOnUiThread {
                webView.evaluateJavascript("if(typeof SleepTimerManager!=='undefined'&&SleepTimerManager.setDuration){SleepTimerManager.setDuration($minutes);}", null)
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String = "3.5.0-HyperFlow"

        @JavascriptInterface
        fun getVersionCode(): Int = 350

        // ── Native Speech Recognition & TTS (Hey Ruby AI) ──

        @JavascriptInterface
        fun isSpeechAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(this@MainActivity)

        @JavascriptInterface
        fun startNativeSpeech(always: Boolean) {
            runOnUiThread { startNativeSpeechListening(always) }
        }

        @JavascriptInterface
        fun stopNativeSpeech() {
            runOnUiThread { stopNativeSpeechListening() }
        }

        @JavascriptInterface
        fun speakText(text: String) {
            runOnUiThread { speakNativeText(text) }
        }

        @JavascriptInterface
        fun stopSpeaking() {
            runOnUiThread { textToSpeech?.stop() }
        }

        @JavascriptInterface
        fun isSpeechListening(): Boolean = isSpeechListening

        // ── Native Media Downloads ──

        @JavascriptInterface
        fun startNativeDownload(url: String, title: String, artist: String) {
            val isVideo = url.contains("format=video")
            val format = if (isVideo) "video" else "audio"
            val quality = if (isVideo) "1080" else "192"
            performNativeDownload(url, title, artist, format, quality)
        }

        @JavascriptInterface
        fun startNativeDownloadAdvanced(url: String, title: String, artist: String, format: String, quality: String) {
            performNativeDownload(url, title, artist, format, quality)
        }

        @JavascriptInterface
        fun installAppUpdate(apkUrl: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, "⏳ Starting 1-Click Update...", Toast.LENGTH_SHORT).show()
            }
            executor.execute {
                try {
                    val resolvedUrl = if (apkUrl.startsWith("/")) "http://127.0.0.1:${LOCAL_PORT}$apkUrl" else apkUrl
                    val client = okhttp3.OkHttpClient.Builder()
                        .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                        .build()

                    val request = okhttp3.Request.Builder().url(resolvedUrl).build()
                    val response = client.newCall(request).execute()
                    if (!response.isSuccessful) {
                        runOnUiThread { Toast.makeText(this@MainActivity, "Update download failed (HTTP ${response.code})", Toast.LENGTH_LONG).show() }
                        return@execute
                    }

                    val apkFile = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "MusicFlow_update.apk")
                    response.body?.byteStream()?.use { input ->
                        FileOutputStream(apkFile).use { output ->
                            input.copyTo(output)
                        }
                    }

                    runOnUiThread {
                        try {
                            val apkUri = FileProvider.getUriForFile(
                                this@MainActivity,
                                "${applicationContext.packageName}.fileprovider",
                                apkFile
                            )
                            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(apkUri, "application/vnd.android.package-archive")
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
                            }
                            startActivity(installIntent)
                            Toast.makeText(this@MainActivity, "✅ Ready to install! Tap Install to update MusicFlow.", Toast.LENGTH_LONG).show()
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to launch package installer: ${e.message}", e)
                            Toast.makeText(this@MainActivity, "Could not open installer: ${e.message}", Toast.LENGTH_LONG).show()
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error downloading update: ${e.message}", e)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Update error: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }

        @JavascriptInterface
        fun saveTrackToDevice(base64Data: String, filename: String, title: String, artist: String) {
            executor.execute {
                try {
                    val rawBytes = Base64.decode(base64Data, Base64.DEFAULT)
                    val safeFilename = filename.replace(Regex("[^a-zA-Z0-9 _.-]"), "").ifEmpty { "song_${System.currentTimeMillis()}.mp3" }

                    val musicDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "MusicFlow")
                    if (!musicDir.exists()) musicDir.mkdirs()

                    val targetFile = File(musicDir, safeFilename)
                    FileOutputStream(targetFile).use { fos ->
                        fos.write(rawBytes)
                        fos.flush()
                    }

                    MediaScannerConnection.scanFile(
                        this@MainActivity,
                        arrayOf(targetFile.absolutePath),
                        arrayOf("audio/mpeg")
                    ) { path, uri ->
                        Log.i(TAG, "MediaScanner indexed: $path -> $uri")
                    }

                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "✅ Saved: $safeFilename in Music/MusicFlow", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to save to public Music dir: ${e.message}", e)
                    try {
                        val fallbackDir = getExternalFilesDir(Environment.DIRECTORY_MUSIC)
                        val safeFilename = filename.replace(Regex("[^a-zA-Z0-9 _.-]"), "").ifEmpty { "song_${System.currentTimeMillis()}.mp3" }
                        val targetFile = File(fallbackDir, safeFilename)
                        FileOutputStream(targetFile).use { it.write(Base64.decode(base64Data, Base64.DEFAULT)) }
                        runOnUiThread {
                            Toast.makeText(this@MainActivity, "✅ Saved to Offline Storage: $safeFilename", Toast.LENGTH_SHORT).show()
                        }
                    } catch (e2: Exception) {
                        Log.e(TAG, "Fallback save failed: ${e2.message}", e2)
                    }
                }
            }
        }

        @JavascriptInterface
        fun isNativeApp(): Boolean = true

        @JavascriptInterface
        fun isStandalone(): Boolean = true
    }

    // ── Broadcast Receivers (Notification & Hardware Media Buttons) ──

    private val webViewCommandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "com.musicflow.player.WEBVIEW_COMMAND") {
                val js = intent.getStringExtra("js") ?: return
                runOnUiThread { webView.evaluateJavascript(js, null) }
            }
        }
    }

    private val mediaButtonReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_MEDIA_BUTTON) {
                val keyEvent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                }
                if (keyEvent?.action == KeyEvent.ACTION_DOWN) {
                    when (keyEvent.keyCode) {
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK ->
                            webView.evaluateJavascript("if(typeof togglePlayPause==='function')togglePlayPause();", null)
                        KeyEvent.KEYCODE_MEDIA_NEXT ->
                            webView.evaluateJavascript("if(typeof playNext==='function')playNext();", null)
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS ->
                            webView.evaluateJavascript("if(typeof playPrev==='function')playPrev();", null)
                    }
                }
            }
        }
    }

    // ── Lifecycle ──

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()

        val cmdFilter = IntentFilter("com.musicflow.player.WEBVIEW_COMMAND")
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
        try { unregisterReceiver(webViewCommandReceiver) } catch (e: Exception) {}
        try { unregisterReceiver(mediaButtonReceiver) } catch (e: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        stopNativeSpeechListening()
        speechRecognizer?.destroy()
        speechRecognizer = null
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null

        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        localServer?.stop()
        localServer = null
        webView.destroy()
        executor.shutdown()
    }

    @Deprecated("Deprecated in API 33+")
    override fun onBackPressed() {
        // If Spotify fullscreen player is open, close it on back press
        webView.evaluateJavascript(
            """
            (function() {
                var sfp = document.getElementById('spotifyFullscreenPlayer');
                if (sfp && sfp.classList.contains('active')) {
                    var sfpLrc = document.getElementById('sfpLyricsOverlay');
                    if (sfpLrc && sfpLrc.classList.contains('active')) {
                        sfpLrc.classList.remove('active');
                        return true;
                    }
                    if (window.SpotifyMobileController && typeof window.SpotifyMobileController.closeFullscreen === 'function') {
                        window.SpotifyMobileController.closeFullscreen();
                        return true;
                    }
                }
                var modals = ['downloadOptionsModal', 'settingsModal', 'sleepTimerModal', 'eqModal', 'shareModal', 'batchImportModal', 'createPlaylistModal'];
                for (var i = 0; i < modals.length; i++) {
                    var m = document.getElementById(modals[i]);
                    if (m && m.style.display !== 'none' && m.offsetWidth > 0) {
                        m.style.display = 'none';
                        return true;
                    }
                }
                var rubyModal = document.getElementById('rubyVoiceModal');
                if (rubyModal && rubyModal.classList.contains('active')) {
                    rubyModal.classList.remove('active');
                    return true;
                }
                var qSidebar = document.getElementById('queueSidebar');
                if (qSidebar && qSidebar.classList.contains('open')) {
                    qSidebar.classList.remove('open');
                    return true;
                }
                return false;
            })();
            """.trimIndent()
        ) { result ->
            if (result == "true") {
                // Handled in JS
                return@evaluateJavascript
            }
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                @Suppress("DEPRECATION") super.onBackPressed()
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> {
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
}
