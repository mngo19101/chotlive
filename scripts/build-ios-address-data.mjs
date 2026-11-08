/**
 * Tạo ios-native/ChotLive/AddressData.json từ đúng danh mục Viettel Post mà web dùng
 * (public/js/vtp-address.js: địa chỉ mới, public/js/vtp-address-old.js: địa chỉ cũ),
 * để app chọn khu vực ra cùng tên với web và file Excel Viettel Post nhận ngay.
 *
 * new: [{ n: tỉnh, w: [phường/xã] }]
 * old: [{ n: tỉnh, d: [{ n: quận/huyện, w: [phường/xã], e: [phường mới tương ứng, "Phường X, TP.Hà Nội"] }] }]
 *
 * Chạy: node scripts/build-ios-address-data.mjs
 */
import fs from 'node:fs';
import { VTP_PROVINCES, vtpWardsOf } from '../public/js/vtp-address.js';
import { VTP_OLD_PROVINCES, vtpOldDistrictsOf, vtpOldWardsOf, findVtpOldAddress } from '../public/js/vtp-address-old.js';

const out = {
  new: VTP_PROVINCES.map(([id, n]) => ({ n, w: vtpWardsOf(id) })),
  old: VTP_OLD_PROVINCES.map(([id, n]) => ({
    n,
    d: vtpOldDistrictsOf(id).map((dn) => {
      const w = vtpOldWardsOf(id, dn);
      const e = w.map((wn) => {
        const r = findVtpOldAddress({ province: n, district: dn, ward: wn });
        return r && r.newWard ? `${r.newWard}, ${r.newProvince}` : '';
      });
      return { n: dn, w, e };
    })
  }))
};

const file = new URL('../ios-native/ChotLive/AddressData.json', import.meta.url);
fs.writeFileSync(file, JSON.stringify(out));
const wards = out.old.reduce((s, p) => s + p.d.reduce((t, d) => t + d.w.length, 0), 0);
const missing = out.old.reduce((s, p) => s + p.d.reduce((t, d) => t + d.e.filter((x) => !x).length, 0), 0);
console.log(`new: ${out.new.length} tỉnh, ${out.new.reduce((s, p) => s + p.w.length, 0)} phường/xã`);
console.log(`old: ${out.old.length} tỉnh, ${out.old.reduce((s, p) => s + p.d.length, 0)} quận/huyện, ${wards} phường/xã (thiếu phường mới: ${missing})`);
console.log(`${fs.statSync(file).size} bytes`);
