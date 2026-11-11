// Áp nền sáng/tối và màu chủ đạo đã chọn ngay khi trang mở, trước khi vẽ,
// để không nháy màu mặc định. Nằm trong file riêng vì CSP chỉ cho chạy script từ /js.
// Lưu theo trình duyệt (localStorage), không theo tài khoản.
(function () {
  var KEY = 'chotlive_theme';
  var MODES = ['auto', 'light', 'dark'];
  var ACCENTS = ['orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green', 'mono'];
  var pick = function (list, v) { return list.indexOf(v) >= 0 ? v : list[0]; };
  var cur = { mode: 'auto', accent: 'orange' };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    cur = { mode: pick(MODES, saved.mode), accent: pick(ACCENTS, saved.accent) };
  } catch (e) {}

  function apply() {
    var el = document.documentElement;
    if (cur.mode === 'auto') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', cur.mode);
    if (cur.accent === 'orange') el.removeAttribute('data-accent'); else el.setAttribute('data-accent', cur.accent);
    // Màu thanh địa chỉ của trình duyệt điện thoại đi theo nền đã chọn.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var isDarkTag = /dark/.test(metas[i].getAttribute('media') || '');
      var dark = cur.mode === 'auto' ? isDarkTag : cur.mode === 'dark';
      metas[i].setAttribute('content', dark ? '#141312' : '#f2f1ee');
    }
  }

  window.chotTheme = {
    get: function () { return { mode: cur.mode, accent: cur.accent }; },
    set: function (patch) {
      cur = { mode: pick(MODES, patch.mode || cur.mode), accent: pick(ACCENTS, patch.accent || cur.accent) };
      apply();
      try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (e) {}
    },
  };
  apply();
})();
