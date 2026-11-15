/** Kết nối Viettel Post của từng tài khoản và danh mục phường/xã, dùng chung cho nhiều route. */
import * as vtp from '../vtp.js';
import { DATA_DIR } from './config.js';

export const vtpStore = vtp.createVtpStore(DATA_DIR);
// Danh mục phường/xã Viettel Post để đối chiếu địa chỉ họ hiểu sau mỗi lần tạo vận đơn.
export const vtpWards = vtp.createVtpWardCatalog(DATA_DIR);
