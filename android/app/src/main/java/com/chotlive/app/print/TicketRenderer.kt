package com.chotlive.app.print

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import androidx.core.content.res.ResourcesCompat
import com.chotlive.app.R
import com.chotlive.app.model.LiveComment
import com.chotlive.app.model.vnd
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.ceil

/** Vẽ tem (hỗ trợ tiếng Việt có dấu) thành ảnh rồi chuyển sang lệnh raster ESC/POS. */
class TicketRenderer(private val context: Context, private val paperWidth: () -> Int, private val shopName: () -> String) {
    private sealed class Block {
        data class Text(val s: String, val size: Float, val face: Typeface, val align: Layout.Alignment) : Block()
        data object Dashed : Block()
        data class Gap(val h: Int) : Block()
    }

    private val extraBold by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_extrabold) ?: Typeface.DEFAULT_BOLD }
    private val bold by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_bold) ?: Typeface.DEFAULT_BOLD }
    private val semiBold by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_semibold) ?: Typeface.DEFAULT_BOLD }
    private val medium by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_medium) ?: Typeface.DEFAULT }

    fun ticketBytes(c: LiveComment): ByteArray = escpos(render(c, live = false))

    /** Tem in từ 1 bình luận đang live: không có giá, giờ là lúc bấm in. */
    fun liveTicketBytes(c: LiveComment): ByteArray = escpos(render(c, live = true))

    fun render(c: LiveComment, live: Boolean): Bitmap {
        val shop = shopName().ifBlank { "ChốtLive" }
        val f = SimpleDateFormat("HH:mm  dd/MM/yyyy", Locale.US)
        val name = c.nickname.ifEmpty { "@" + c.uniqueId }
        val L = Layout.Alignment.ALIGN_NORMAL
        val C = Layout.Alignment.ALIGN_CENTER

        val blocks = mutableListOf<Block>(
            Block.Text(shop.uppercase(), 40f, extraBold, C),
            Block.Dashed,
            Block.Text("Tên TikTok: $name", 38f, extraBold, L),
            Block.Text("ID TikTok: @${c.uniqueId}", 28f, semiBold, L),
            Block.Text(if (live) "Giờ in: " + f.format(Date()) else "Giờ: " + f.format(Date(c.ts)), 26f, medium, L),
            Block.Dashed,
            Block.Text("Bình luận:", 24f, medium, L),
            Block.Text(c.text, 36f, bold, L),
            Block.Dashed,
        )
        if (!live) {
            blocks += Block.Text(vnd(c.price), 64f, extraBold, C)
            blocks += Block.Gap(10)
            blocks += Block.Dashed
        }
        blocks += Block.Gap(20)

        val width = paperWidth()
        val margin = 16
        val cw = width - margin * 2
        val spacing = 8

        fun layout(b: Block.Text): StaticLayout {
            val p = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.BLACK
                textSize = b.size
                typeface = b.face
            }
            return StaticLayout.Builder.obtain(b.s, 0, b.s.length, p, cw).setAlignment(b.align).setIncludePad(false).build()
        }

        val layouts = blocks.map { if (it is Block.Text) layout(it) else null }
        var total = 12
        blocks.forEachIndexed { i, b ->
            total += when (b) {
                is Block.Text -> layouts[i]!!.height + spacing
                Block.Dashed -> 14
                is Block.Gap -> b.h
            }
        }
        total += 12
        val height = (ceil(total / 8.0) * 8).toInt()

        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawColor(Color.WHITE)
        val dash = Paint().apply {
            color = Color.BLACK
            strokeWidth = 2f
            style = Paint.Style.STROKE
            pathEffect = DashPathEffect(floatArrayOf(10f, 7f), 0f)
        }
        var y = 12f
        blocks.forEachIndexed { i, b ->
            when (b) {
                is Block.Text -> {
                    val l = layouts[i]!!
                    canvas.save()
                    canvas.translate(margin.toFloat(), y)
                    l.draw(canvas)
                    canvas.restore()
                    y += l.height + spacing
                }
                Block.Dashed -> {
                    canvas.drawLine(margin.toFloat(), y + 6, (width - margin).toFloat(), y + 6, dash)
                    y += 14
                }
                is Block.Gap -> y += b.h
            }
        }
        return bmp
    }

    companion object {
        /** Ảnh -> ESC/POS raster (GS v 0), chia dải 128 dòng cho máy in nhỏ bộ đệm. */
        fun escpos(bmp: Bitmap): ByteArray {
            val w = bmp.width
            val h = bmp.height
            val bytesPerRow = (w + 7) / 8
            val px = IntArray(w * h)
            bmp.getPixels(px, 0, w, 0, 0, w, h)
            val out = ByteArrayOutputStream()
            out.write(byteArrayOf(0x1B, 0x40)) // ESC @
            var y = 0
            while (y < h) {
                val rows = minOf(128, h - y)
                out.write(byteArrayOf(0x1D, 0x76, 0x30, 0x00,
                    (bytesPerRow and 0xFF).toByte(), (bytesPerRow shr 8).toByte(),
                    (rows and 0xFF).toByte(), (rows shr 8).toByte()))
                for (r in y until y + rows) {
                    for (bx in 0 until bytesPerRow) {
                        var byte = 0
                        for (bit in 0 until 8) {
                            val x = bx * 8 + bit
                            if (x < w) {
                                val c = px[r * w + x]
                                val gray = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000
                                if (gray < 150) byte = byte or (0x80 shr bit)
                            }
                        }
                        out.write(byte)
                    }
                }
                y += rows
            }
            out.write(byteArrayOf(0x1B, 0x64, 0x04))       // feed 4 dòng
            out.write(byteArrayOf(0x1D, 0x56, 0x42, 0x00)) // cắt giấy (máy không có dao sẽ bỏ qua)
            return out.toByteArray()
        }
    }
}
