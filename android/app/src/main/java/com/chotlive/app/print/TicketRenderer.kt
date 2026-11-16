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

    fun ticketBytes(c: LiveComment): ByteArray = escpos(render(c, live = false))

    /** Tem in từ 1 bình luận đang live: giờ là lúc bấm in. `c.price` là tổng tiền các món của bình luận
     *  (0 thì không in dòng giá). */
    fun liveTicketBytes(c: LiveComment): ByteArray = escpos(render(c, live = true))

    /** Tem gọn để tốn ít giấy: tên shop, tên khách, @id + giờ trên 1 dòng, bình luận, giá. */
    fun render(c: LiveComment, live: Boolean): Bitmap {
        val shop = shopName().ifBlank { "ChốtLive" }
        val f = SimpleDateFormat("HH:mm dd/MM/yyyy", Locale.US)
        val name = c.nickname.ifEmpty { "@" + c.uniqueId }
        val time = f.format(if (live) Date() else Date(c.ts))
        val L = Layout.Alignment.ALIGN_NORMAL
        val C = Layout.Alignment.ALIGN_CENTER

        val blocks = mutableListOf<Block>(
            Block.Text(shop.uppercase(), 28f, extraBold, C),
            Block.Dashed,
            Block.Text(name, 34f, extraBold, L),
            Block.Text("@${c.uniqueId}  ·  $time", 22f, semiBold, L),
            Block.Dashed,
            Block.Text(c.text, 30f, bold, L),
        )
        if (c.price > 0) {
            blocks += Block.Dashed
            blocks += Block.Text(vnd(c.price), 48f, extraBold, C)
        }

        val width = paperWidth()
        val margin = 12
        val cw = width - margin * 2
        val spacing = 4

        fun layout(b: Block.Text): StaticLayout {
            val p = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.BLACK
                textSize = b.size
                typeface = b.face
            }
            return StaticLayout.Builder.obtain(b.s, 0, b.s.length, p, cw).setAlignment(b.align).setIncludePad(false).build()
        }

        val layouts = blocks.map { if (it is Block.Text) layout(it) else null }
        var total = 6
        blocks.forEachIndexed { i, b ->
            total += when (b) {
                is Block.Text -> layouts[i]!!.height + spacing
                Block.Dashed -> 14
                is Block.Gap -> b.h
            }
        }
        total += 6
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
        var y = 6f
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
            fun dark(c: Int) = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000 < 150
            // Bỏ dòng trắng cuối ảnh (khoảng chừa dưới chân chữ), chỉ giữ 16 chấm (2mm) sau dòng có mực
            // cuối cùng để dao cắt lệch một chút cũng không cắt vào chữ.
            var inked = h
            while (inked > 0 && (0 until w).none { dark(px[(inked - 1) * w + it]) }) inked--
            val printed = minOf(h, inked + 16)

            val out = ByteArrayOutputStream()
            out.write(byteArrayOf(0x1B, 0x40)) // ESC @
            var y = 0
            while (y < printed) {
                val rows = minOf(128, printed - y)
                out.write(byteArrayOf(0x1D, 0x76, 0x30, 0x00,
                    (bytesPerRow and 0xFF).toByte(), (bytesPerRow shr 8).toByte(),
                    (rows and 0xFF).toByte(), (rows shr 8).toByte()))
                for (r in y until y + rows) {
                    for (bx in 0 until bytesPerRow) {
                        var byte = 0
                        for (bit in 0 until 8) {
                            val x = bx * 8 + bit
                            if (x < w && dark(px[r * w + x])) byte = byte or (0x80 shr bit)
                        }
                        out.write(byte)
                    }
                }
                y += rows
            }
            // GS V 66 0: máy tự đẩy giấy tới dao rồi mới cắt, nên không cần ESC d trước đó
            // (ESC d sẽ đẩy thêm khoảng trắng thừa dưới chân tem).
            out.write(byteArrayOf(0x1D, 0x56, 0x42, 0x00))
            return out.toByteArray()
        }
    }
}
