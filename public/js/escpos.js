/**
 * Chuyển canvas đen trắng thành lệnh ESC/POS (GS v 0 – in ảnh raster).
 * Dùng cho Xprinter Q80BS và hầu hết máy in nhiệt 58/80mm.
 * Bản web dùng để tính kích thước dữ liệu; bản iPhone sẽ gửi y hệt các byte này qua Bluetooth.
 */
export function canvasToEscPos(canvas, { cut = true, feedLines = 3 } = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const bytesPerRow = Math.ceil(w / 8);
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;

  const raster = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i] < 128) raster[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const head = [
    0x1b, 0x40, // ESC @  – khởi tạo
    0x1b, 0x61, 0x01, // ESC a 1 – căn giữa
    0x1d, 0x76, 0x30, 0x00, // GS v 0 m=0
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    h & 0xff, (h >> 8) & 0xff,
  ];
  const tail = [0x1b, 0x64, feedLines]; // ESC d n – đẩy giấy
  if (cut) tail.push(0x1d, 0x56, 0x42, 0x00); // GS V B 0 – cắt giấy

  const out = new Uint8Array(head.length + raster.length + tail.length);
  out.set(head, 0);
  out.set(raster, head.length);
  out.set(tail, head.length + raster.length);
  return out;
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}
