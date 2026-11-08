package com.chotlive.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.chotlive.app.ui.RootView

class MainActivity : ComponentActivity() {
    private val app: ChotLiveApp get() = application as ChotLiveApp
    private var dark: Boolean? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyBars(false)
        // Ở màn gốc, nút Back đưa app xuống nền thay vì đóng hẳn: đang live thì mở lại là thấy ngay.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
        handleIntent(intent)
        setContent {
            RootView(app) { applyBars(it) }
        }
    }

    private fun applyBars(isDark: Boolean) {
        if (dark == isDark) return
        dark = isDark
        val style = if (isDark) SystemBarStyle.dark(Color.TRANSPARENT)
        else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_OPEN_SUPPORT, false) == true) {
            intent.removeExtra(EXTRA_OPEN_SUPPORT)
            app.openSupportRequest++
        }
    }

    override fun onResume() {
        super.onResume()
        app.client.checkSocket()
        app.printer.refreshStatus()
    }

    override fun onPause() {
        super.onPause()
        app.store.save()
    }

    companion object {
        const val EXTRA_OPEN_SUPPORT = "openSupportChat"
    }
}
