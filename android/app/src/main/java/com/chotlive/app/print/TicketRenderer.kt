package com.chotlive.app.print

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Typeface
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
    private class Style(val size: Float, val face: Typeface)

    private sealed class Block {
        /** Chữ bên trái (tự xuống dòng) và chữ bên phải 1 dòng, thẳng chân chữ dòng đầu. Phải rỗng thì trái chiếm hết. */
        data class Row(val left: String, val ls: Style, val right: String = "", val rs: Style = ls) : Block()
        data object Dashed : Block()
    }

    private val extraBold by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_extrabold) ?: Typeface.DEFAULT_BOLD }
    private val bold by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_bold) ?: Typeface.DEFAULT_BOLD }
    private val semiBold by lazy { ResourcesCompat.getFont(context, R.font.bevietnampro_semibold) ?: Typeface.DEFAULT_BOLD }

    fun ticketBytes(c: LiveComment): ByteArray = escpos(render(c, live = false))

    /** Tem in từ 1 bình luận đang live: giờ là lúc bấm in. `c.price` là tổng tiền các món của bình luận
     *  (0 thì không in dòng giá). */
    fun liveTicketBytes(c: LiveComment): ByteArray = escpos(render(c, live = true))

    /** Tem nhỏ gọn, 4 dòng:
     *    CHỐTLIVE                 15:06 16/11
     *    Tên khách
     *    @id
     *    - - - - - - - - - - - - - - - - - -
     *    bình luận                    30.000đ */
    fun render(c: LiveComment, live: Boolean): Bitmap {
        val shop = shopName().ifBlank { "ChốtLive" }
        val f = SimpleDateFormat("HH:mm dd/MM", Locale.US)
        val name = c.nickname.ifEmpty { "@" + c.uniqueId }
        val small = Style(25f, semiBold)

        val blocks = mutableListOf<Block>(
            Block.Row(shop.uppercase(), Style(25f, extraBold), f.format(if (live) Date() else Date(c.ts)), small),
            Block.Row(name, Style(35f, extraBold)),
        )
        if (c.nickname.isNotEmpty()) blocks += Block.Row("@${c.uniqueId}", small)
        blocks += Block.Dashed
        blocks += Block.Row(c.text, Style(32f, bold), if (c.price > 0) vnd(c.price) else "", Style(40f, extraBold))

        val width = paperWidth()
        val margin = 12
        val cw = width - margin * 2
        val spacing = 2
        val dashH = 12

        fun paint(s: Style) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.BLACK
            textSize = s.size
            typeface = s.face
        }
        fun layout(s: String, st: Style, w: Int): StaticLayout =
            StaticLayout.Builder.obtain(s, 0, s.length, paint(st), w).setIncludePad(false).build()

        /** 1 dòng đã xếp: layout + toạ độ (so với đầu dòng) của 2 bên, và chiều cao dòng. */
        class Placed(val left: StaticLayout, val leftTop: Int, val right: StaticLayout?, val rightX: Int,
                     val rightTop: Int, val height: Int)
        fun place(b: Block.Row): Placed {
            val rw = if (b.right.isEmpty()) 0 else ceil(paint(b.rs).measureText(b.right)).toInt()
            val lw = if (b.right.isEmpty()) cw else maxOf(cw / 3, cw - rw - 16)
            val l = layout(b.left, b.ls, lw)
            val r = if (b.right.isEmpty()) null else layout(b.right, b.rs, rw + 2)
            val base = maxOf(l.getLineBaseline(0), r?.getLineBaseline(0) ?: 0)
            val lt = base - l.getLineBaseline(0)
            val rt = if (r == null) 0 else base - r.getLineBaseline(0)
            return Placed(l, lt, r, width - margin - rw, rt, maxOf(lt + l.height, if (r == null) 0 else rt + r.height))
        }

        val placed = blocks.map { if (it is Block.Row) place(it) else null }
        var total = 6
        blocks.forEachIndexed { i, b ->
            total += when (b) {
                is Block.Row -> placed[i]!!.height + spacing
                Block.Dashed -> dashH
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
        fun draw(l: StaticLayout, x: Int, y: Float) {
            canvas.save()
            canvas.translate(x.toFloat(), y)
            l.draw(canvas)
            canvas.restore()
        }
        var y = 6f
        blocks.forEachIndexed { i, b ->
            when (b) {
                is Block.Row -> {
                    val p = placed[i]!!
                    draw(p.left, margin, y + p.leftTop)
                    p.right?.let { draw(it, p.rightX, y + p.rightTop) }
                    y += p.height + spacing
                }
                Block.Dashed -> {
                    canvas.drawLine(margin.toFloat(), y + dashH / 2f, (width - margin).toFloat(), y + dashH / 2f, dash)
                    y += dashH
                }
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
