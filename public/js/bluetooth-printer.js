/**
 * Trình điều khiển kết nối máy in nhiệt phần cứng thật (Xprinter Q80BS / Xprinter XP-N160I / ...)
 * Hỗ trợ:
 * 1. Web Bluetooth API (Kết nối Bluetooth không dây trực tiếp từ Chrome/Edge/Android/Bluefy iOS)
 * 2. Web Serial API (Kết nối cáp USB / COM trực tiếp không cần cài driver)
 * 3. In qua Driver hệ thống (Tạo trang in 80mm chuẩn, tương thích mọi máy in cài sẵn trên Windows/Mac)
 * 4. In qua mạng LAN / WiFi (Gửi byte ESC/POS tới cổng 9100 của máy in qua server proxy)
 */

import { authHeaders } from './sync.js';

export const printerState = {
  type: 'virtual', // 'virtual' | 'bluetooth' | 'serial' | 'lan' | 'system'
  connected: false,
  deviceName: 'Máy in ảo (Mô phỏng)',
  device: null,
  characteristic: null,
  serialPort: null,
  lanIp: '',
  lanPort: 9100,
};

// UUIDs chuẩn của máy in nhiệt Bluetooth ESC/POS (Xprinter, Epson, Hoin, Goojprt)
const BT_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Chuẩn POS Printer
  '0000ffe0-0000-1000-8000-00805f9b34fb', // Xprinter / Feasycom
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC Transparent
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

const BT_CHARACTERISTICS = [
  '00002af1-0000-1000-8000-00805f9b34fb',
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '49535343-aca3-481c-91ec-d85e28a60318',
  'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
];

/**
 * 1. KẾT NỐI MÁY IN BLUETOOTH
 */
export async function connectBluetooth() {
  if (!navigator.bluetooth) {
    throw new Error('Trình duyệt của bạn chưa hỗ trợ Web Bluetooth. Vui lòng dùng Chrome, Edge hoặc app Bluefy trên iOS.');
  }

  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: BT_SERVICES,
  });

  const server = await device.gatt.connect();
  let targetChar = null;

  for (const sUuid of BT_SERVICES) {
    try {
      const service = await server.getPrimaryService(sUuid);
      for (const cUuid of BT_CHARACTERISTICS) {
        try {
          const char = await service.getCharacteristic(cUuid);
          if (char) { targetChar = char; break; }
        } catch {}
      }
      if (targetChar) break;
    } catch {}
  }

  if (!targetChar) {
    // Thử quét mọi characteristic có quyền write
    try {
      const services = await server.getPrimaryServices();
      for (const s of services) {
        const chars = await s.getCharacteristics();
        for (const c of chars) {
          if (c.properties.write || c.properties.writeWithoutResponse) {
            targetChar = c;
            break;
          }
        }
        if (targetChar) break;
      }
    } catch {}
  }

  if (!targetChar) {
    throw new Error('Đã kết nối Bluetooth nhưng không tìm thấy kênh ghi dữ liệu ESC/POS của máy in.');
  }

  printerState.type = 'bluetooth';
  printerState.connected = true;
  printerState.device = device;
  printerState.characteristic = targetChar;
  printerState.deviceName = device.name || 'Xprinter Q80BS (Bluetooth)';

  device.addEventListener('gattserverdisconnected', () => {
    printerState.connected = false;
    printerState.type = 'virtual';
    printerState.deviceName = 'Máy in ảo (Mô phỏng)';
  });

  return printerState;
}

/**
 * 2. KẾT NỐI MÁY IN USB / SERIAL CABLE
 */
export async function connectSerial() {
  if (!navigator.serial) {
    throw new Error('Trình duyệt chưa hỗ trợ Web Serial. Vui lòng dùng Chrome hoặc Edge trên máy tính.');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });

  printerState.type = 'serial';
  printerState.connected = true;
  printerState.serialPort = port;
  printerState.deviceName = 'Xprinter Q80BS (USB/COM)';
  return printerState;
}

/**
 * 3. GỬI DỮ LIỆU ESC/POS RA PHẦN CỨNG THẬT
 */
export async function printHardwareEscPos(bytes) {
  if (printerState.type === 'bluetooth' && printerState.characteristic) {
    // Bluetooth LE cần chia thành từng gói nhỏ (chunk 100 bytes) để không bị tràn buffer
    const CHUNK_SIZE = 100;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const slice = bytes.slice(i, i + CHUNK_SIZE);
      if (printerState.characteristic.writeValueWithoutResponse) {
        await printerState.characteristic.writeValueWithoutResponse(slice);
      } else {
        await printerState.characteristic.writeValue(slice);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    return true;
  }

  if (printerState.type === 'serial' && printerState.serialPort?.writable) {
    const writer = printerState.serialPort.writable.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
    return true;
  }

  if (printerState.type === 'lan' && printerState.lanIp) {
    const res = await fetch('/api/print-lan', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        ip: printerState.lanIp,
        port: printerState.lanPort || 9100,
        bytes: Array.from(bytes),
      }),
    });
    return res.ok;
  }

  return false;
}

/**
 * 4. IN QUA HỘP THOẠI HỆ THỐNG / WINDOWS DRIVER KHỔ 80MM
 */
export function printViaSystemDriver(canvas, title = 'Tem in đơn hàng') {
  const dataUrl = canvas.toDataURL('image/png');
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${title}</title>
        <style>
          @page { size: 80mm auto; margin: 0; }
          body { margin: 0; padding: 0; display: flex; justify-content: center; }
          img { width: 72mm; max-width: 100%; height: auto; display: block; }
        </style>
      </head>
      <body>
        <img src="${dataUrl}" onload="window.print(); setTimeout(() => { window.frameElement.remove(); }, 1000);" />
      </body>
    </html>
  `);
  doc.close();
}
