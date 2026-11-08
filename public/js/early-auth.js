// Đã có phiên lưu trên máy thì ẩn khung đăng nhập ngay, khỏi nháy lên mỗi lần F5
// trong lúc app.js còn đang tải và hỏi /api/auth/me. Phiên hỏng thì app.js sẽ hiện lại.
// Nằm trong file riêng (không viết thẳng trong index.html) vì CSP chỉ cho chạy script từ /js.
try {
  if (localStorage.getItem('susu_auth_token')) {
    document.getElementById('auth-screen-overlay').classList.add('hidden');
  }
} catch (e) {}
