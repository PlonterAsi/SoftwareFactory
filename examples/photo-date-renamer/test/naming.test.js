import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatName } from '../src/naming.js';

describe('formatName', () => {
  const date = new Date(2024, 4, 17, 14, 3, 22);

  test('formatName(new Date(2024, 4, 17, 14, 3, 22), \'JPG\') returns \'2024-05-17_14-03-22.jpg\', and the ext argument works with or without a leading dot.', () => {
    assert.equal(formatName(date, 'JPG'), '2024-05-17_14-03-22.jpg');
    assert.equal(formatName(date, '.JPG'), '2024-05-17_14-03-22.jpg');
  });

  test('formatName returns YYYY-MM-DD_HH-mm-ss with the lowercased extension', () => {
    assert.equal(formatName(date, 'jpeg'), '2024-05-17_14-03-22.jpeg');
    assert.equal(formatName(date, '.JPEG'), '2024-05-17_14-03-22.jpeg');
  });

  test('formatName uses local-time fields and zero-pads single-digit values', () => {
    const d = new Date(2031, 0, 2, 3, 4, 5);
    assert.equal(formatName(d, '.jpg'), '2031-01-02_03-04-05.jpg');
  });
});
