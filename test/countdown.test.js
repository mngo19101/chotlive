import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countdownClock, countdownText, remainingText } from '../public/js/countdown.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('đếm ngược đủ ngày, giờ, phút, giây và bỏ phần đầu đã về 0', () => {
  assert.equal(countdownText(3 * DAY), '3 ngày 0 giờ 00 phút 00 giây');
  assert.equal(countdownText(2 * DAY + 23 * HOUR + 4 * MINUTE + 9 * SECOND), '2 ngày 23 giờ 04 phút 09 giây');
  assert.equal(countdownText(5 * HOUR + 7 * SECOND), '5 giờ 00 phút 07 giây');
  assert.equal(countdownText(14 * MINUTE + 8 * SECOND), '14 phút 08 giây');
  assert.equal(countdownText(59 * SECOND), '59 giây');
});

test('còn chút ít thì vẫn hiện 1 giây, hết hạn thì 0 giây, không ra số âm', () => {
  assert.equal(countdownText(1), '01 giây');
  assert.equal(countdownText(0), '00 giây');
  assert.equal(countdownText(-5 * MINUTE), '00 giây');
});

test('dạng đồng hồ ngắn cho thanh bên', () => {
  assert.equal(countdownClock(2 * DAY + 23 * HOUR + 4 * MINUTE + 9 * SECOND), '2 ngày 23:04:09');
  assert.equal(countdownClock(5 * HOUR + 7 * SECOND), '05:00:07');
  assert.equal(countdownClock(1), '00:00:01');
  assert.equal(countdownClock(-1), '00:00:00');
});

test('thời gian còn của gói tính theo giờ, hết hạn thì không ra số âm', () => {
  assert.equal(remainingText(30 * DAY), '30 ngày');
  assert.equal(remainingText(20 * DAY + 3 * HOUR + 59 * MINUTE), '20 ngày 3 giờ');
  assert.equal(remainingText(5 * HOUR + 30 * MINUTE), '5 giờ');
  assert.equal(remainingText(59 * MINUTE), 'dưới 1 giờ');
  assert.equal(remainingText(-DAY), 'dưới 1 giờ');
});
