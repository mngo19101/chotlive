/**
 * Xuất dữ liệu đơn hàng ra file Excel / CSV chuẩn UTF-8
 * Tương thích trực tiếp với Microsoft Excel, Google Sheets, GHTK, GHN, Viettel Post
 */

export function exportOrdersToCSV(orders = []) {
  if (!orders || orders.length === 0) {
    throw new Error('Chưa có đơn hàng nào để xuất file.');
  }

  const headers = [
    'Mã đơn hàng',
    'Thời gian tạo',
    'Tên khách hàng',
    'TikTok Username',
    'TikTok CarID',
    'Số điện thoại',
    'Địa chỉ nhận hàng',
    'Chi tiết sản phẩm mua',
    'Tổng số lượng món',
    'Tiền hàng (VND)',
    'Phí ship (VND)',
    'Giảm giá (VND)',
    'Tổng thu (COD VND)',
    'Trạng thái',
    'Ghi chú đơn hàng'
  ];

  const statusLabel = {
    new: 'Đơn mới',
    packing: 'Đang đóng gói',
    shipping: 'Đang giao',
    done: 'Hoàn tất',
    cancelled: 'Đã huỷ'
  };

  const rows = orders.map((o) => {
    const d = new Date(o.ts || Date.now());
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const items = o.items || [];
    const itemsDetail = items.map((it, i) => `${i + 1}. ${it.name} (SL: ${it.qty || 1} • ${(it.price || 0).toLocaleString('vi-VN')}đ)`).join('; ');
    const totalQty = items.reduce((s, it) => s + (it.qty || 1), 0);

    return [
      `"${o.code || ''}"`,
      `"${timeStr}"`,
      `"${(o.nickname || '').replace(/"/g, '""')}"`,
      `"@${(o.uniqueId || '').replace(/"/g, '""')}"`,
      `"'\t${o.userId || ''}"`, // Thêm ký tự để Excel không làm tròn chuỗi số ID dài
      `"'\t${o.phone || ''}"`,
      `"${(o.address || '').replace(/"/g, '""')}"`,
      `"${itemsDetail.replace(/"/g, '""')}"`,
      totalQty,
      o.subtotal || o.total || 0,
      o.shippingFee || 0,
      o.discount || 0,
      o.total || 0,
      `"${statusLabel[o.status || 'new'] || o.status}"`,
      `"${(o.note || '').replace(/"/g, '""')}"`
    ].join(',');
  });

  // \uFEFF là Byte Order Mark (BOM) bắt buộc để Excel nhận diện chuẩn tiếng Việt UTF-8
  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const filename = `DonHang_ChotDon_${dateStr}.csv`;

  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return { filename, count: orders.length, csvContent };
}
