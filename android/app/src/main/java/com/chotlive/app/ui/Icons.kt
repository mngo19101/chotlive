package com.chotlive.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

// Hình dạng icon dựa trên bộ Lucide (giấy phép ISC, https://lucide.dev), vẽ trên lưới 24×24.

private fun circle(cx: Double, cy: Double, r: Double) =
    "M${cx - r} ${cy}A$r $r 0 1 0 ${cx + r} ${cy}A$r $r 0 1 0 ${cx - r} ${cy}Z"

enum class IconName(vararg val d: String) {
    CHART("M1.5 20.5h21", "M7 20.5V12", "M12 20.5V5", "M17 20.5v-7"),
    MESSAGE_LINES("M7.9 20A9 9 0 1 0 4 16.1L2 22Z", "M8 10h8", "M8 14h5"),
    MESSAGE("M7.9 20A9 9 0 1 0 4 16.1L2 22Z"),
    MESSAGE_SQUARE("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"),
    USERS("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9.0, 7.0, 4.0), "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"),
    BAG("M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z", "M3 6h18", "M16 10a4 4 0 0 1-8 0"),
    USER("M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", circle(12.0, 7.0, 4.0)),
    CALENDAR("M8 2v4", "M16 2v4", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "M3 10h18"),
    PLUS("M5 12h14", "M12 5v14"),
    MINUS("M5 12h14"),
    CHEVRON_LEFT("M15 18 9 12 15 6"),
    CHEVRON_RIGHT("M9 18 15 12 9 6"),
    CHEVRON_DOWN("M6 9 12 15 18 9"),
    CHEVRON_UP("M18 15 12 9 6 15"),
    ARROW_RIGHT("M5 12h14", "M12 5 19 12 12 19"),
    ARROW_DOWN("M12 5v14", "M19 12 12 19 5 12"),
    RADIO("M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5", circle(12.0, 12.0, 2.0), "M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"),
    SEARCH(circle(11.0, 11.0, 8.0), "M21 21 16.7 16.7"),
    FILTER("M3 6h18", "M7 12h10", "M10 18h4"),
    PRINTER(
        "M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2",
        "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6",
        "M7 14h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z",
    ),
    TRUCK(
        "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2", "M15 18H9",
        "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14",
        circle(17.0, 18.0, 2.0), circle(7.0, 18.0, 2.0),
    ),
    MORE(circle(5.0, 12.0, 1.0), circle(12.0, 12.0, 1.0), circle(19.0, 12.0, 1.0)),
    CHECK("M20 6 9 17 4 12"),
    TAG(
        "M11.414 2.586A2 2 0 0 1 12.828 2H20a2 2 0 0 1 2 2v7.172a2 2 0 0 1-.586 1.414l-8.704 8.704a2.426 2.426 0 0 1-3.42 0l-6.58-6.58a2.426 2.426 0 0 1 0-3.42Z",
        circle(16.5, 7.5, 0.5),
    ),
    BELL(
        "M10.268 21a2 2 0 0 0 3.464 0",
        "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
    ),
    HELP(circle(12.0, 12.0, 10.0), "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"),
    LOGOUT("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17 21 12 16 7", "M21 12H9"),
    CART(circle(8.0, 21.0, 1.0), circle(19.0, 21.0, 1.0), "M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"),
    TRASH("M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", "M10 11v6", "M14 11v6"),
    CLOSE("M18 6 6 18", "M6 6 18 18"),
    PENCIL("M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z"),
    PIN("M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0", circle(12.0, 10.0, 3.0)),
    PALETTE(
        circle(13.5, 6.5, 0.5), circle(17.5, 10.5, 0.5), circle(8.5, 7.5, 0.5), circle(6.5, 12.5, 0.5),
        "M12 2C6.5 2 2 6.5 2 12C2 17.5 6.5 22 12 22C12.926 22 13.648 21.254 13.648 20.312C13.648 19.875 13.468 19.477 13.211 19.187C12.921 18.898 12.773 18.535 12.773 18.062A1.64 1.64 0 0 1 14.441 16.394H16.437C19.488 16.394 21.992 13.891 21.992 10.84C21.965 6.012 17.461 2 12 2Z",
    ),
    SUN(circle(12.0, 12.0, 4.0), "M12 2v2", "M12 20v2", "M4.93 4.93l1.41 1.41", "M17.66 17.66l1.41 1.41",
        "M2 12h2", "M20 12h2", "M6.34 17.66l-1.41 1.41", "M19.07 4.93l-1.41 1.41"),
    MOON("M12 3a6 6 0 0 0 9 9 9 9 0 1 1 -9 -9Z"),
    SMARTPHONE("M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M12 18h.01"),
    DOWNLOAD("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10 12 15 17 10", "M12 15V3"),
    COPY("M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"),
    ALERT("M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z", "M12 8v4", "M12 16h.01"),
    STOP("M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z");

    val path: Path by lazy {
        val p = Path()
        for (s in d) p.addPath(PathParser().parsePathString(s).toPath())
        p
    }
}

@Composable
fun Icon(name: IconName, size: Float = 20f, weight: Float = 2f, color: Color = C.ink, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size.dp)) {
        val s = this.size.minDimension / 24f
        scale(s, s, pivot = Offset.Zero) {
            drawPath(name.path, color, style = Stroke(width = weight, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}
